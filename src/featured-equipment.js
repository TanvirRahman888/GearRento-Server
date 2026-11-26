import Stripe from "stripe";
import { ObjectId } from "mongodb";

// ======================================
// Configuration
// ======================================

const DURATIONS = [5, 15, 30];
const MIN_FEE_PAISA = 3000;
const DAY_MS = 86_400_000;

let stripeClient;

// ======================================
// Stripe Client
// ======================================

function stripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();

    if (!key?.startsWith("sk_test_")) {
      throw new Error("STRIPE_SECRET_KEY must be a Stripe test secret key.");
    }

    stripeClient = new Stripe(key);
  }

  return stripeClient;
}

// ======================================
// Helpers
// ======================================

function validEquipmentId(id) {
  return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);
}

function idCandidates(id) {
  const ids = [id];

  if (validEquipmentId(id)) {
    ids.push(new ObjectId(id));
  }

  return ids;
}

// ======================================
// Promotion Pricing
// ======================================

function calculateQuote(dailyPrice, days) {
  const dailyPaisa = Math.round(Number(dailyPrice) * 100);

  if (!Number.isSafeInteger(dailyPaisa) || dailyPaisa <= 0) {
    return null;
  }

  const basePaisa = Math.round((dailyPaisa * days) / 100);

  const capPaisa = Math.floor((dailyPaisa * days * 2) / 100);

  const minimumBDT = Number(process.env.STRIPE_FEATURE_MIN_BDT || 0);

  if (!Number.isFinite(minimumBDT) || minimumBDT < 0) {
    throw new Error("Invalid STRIPE_FEATURE_MIN_BDT.");
  }

  const amountPaisa = Math.max(
    MIN_FEE_PAISA,
    basePaisa,
    Math.round(minimumBDT * 100),
  );

  if (!Number.isSafeInteger(amountPaisa) || amountPaisa > 99_999_999) {
    return null;
  }

  return {
    days,
    amountPaisa,
    amountBDT: amountPaisa / 100,
    eligible: amountPaisa <= capPaisa,
    effectivePercent: Number(
      ((amountPaisa / (dailyPaisa * days)) * 100).toFixed(3),
    ),
  };
}

// ======================================
// Find Owner's Approved Equipment
// ======================================

async function ownedApprovedEquipment(db, id, ownerId) {
  return db.collection("equipment").findOne(
    {
      _id: new ObjectId(id),

      ownerId: {
        $in: idCandidates(ownerId),
      },

      status: "approved",

      availableQuantity: {
        $gt: 0,
      },
    },
    {
      projection: {
        name: 1,
        dailyPrice: 1,
        ownerId: 1,
        featureExpiresAt: 1,
      },
    },
  );
}

// ======================================
// Register Owner Routes
// ======================================

export function registerFeaturedEquipmentRoutes(
  app,
  { getDb, getMongoClient, verifyJWT, requireRole },
) {
  const auth = [verifyJWT, requireRole("owner")];

  // ====================================
  // GET Promotion Quote
  // ====================================

  app.get("/owner/equipment/:id/feature/quote", ...auth, async (req, res) => {
    try {
      if (!validEquipmentId(req.params.id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid equipment ID.",
        });
      }

      const equipment = await ownedApprovedEquipment(
        getDb(),
        req.params.id,
        req.authUser.id,
      );

      if (!equipment) {
        return res.status(404).json({
          success: false,
          error: "No eligible approved equipment found for this Owner.",
        });
      }

      res.set("Cache-Control", "no-store");

      return res.json({
        success: true,

        equipment: {
          id: equipment._id.toString(),
          name: equipment.name,
          dailyPrice: equipment.dailyPrice,
          featureExpiresAt: equipment.featureExpiresAt || null,
        },

        pricing: {
          baseRatePercent: 1,
          maxRatePercent: 2,
          minimumTotalBDT: 30,
        },

        options: DURATIONS.map((days) =>
          calculateQuote(equipment.dailyPrice, days),
        ).filter(Boolean),
      });
    } catch (error) {
      console.error("Featured quote failed:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load promotion prices.",
      });
    }
  });

  // ====================================
  // POST Create Stripe Checkout
  // ====================================

  app.post(
    "/owner/equipment/:id/feature/checkout",
    ...auth,
    async (req, res) => {
      try {
        const days = req.body?.days;

        if (!validEquipmentId(req.params.id) || !DURATIONS.includes(days)) {
          return res.status(400).json({
            success: false,
            error: "Choose valid equipment and 5, 15, or 30 days.",
          });
        }

        const db = getDb();

        const equipment = await ownedApprovedEquipment(
          db,
          req.params.id,
          req.authUser.id,
        );

        if (!equipment) {
          return res.status(404).json({
            success: false,
            error: "Equipment is not eligible for promotion.",
          });
        }

        const quote = calculateQuote(equipment.dailyPrice, days);

        if (!quote?.eligible) {
          return res.status(400).json({
            success: false,
            error:
              "This option cannot meet both the ৳30 minimum and 2% maximum. Choose a longer duration.",
          });
        }

        const clientURL = process.env.CLIENT_URL?.replace(/\/+$/, "");

        if (!clientURL) {
          throw new Error("CLIENT_URL is missing.");
        }

        const features = db.collection("equipmentFeatures");

        const featureId = new ObjectId();
        const now = new Date();

        // ==================================
        // Create Pending Purchase
        // ==================================

        await features.insertOne({
          _id: featureId,

          equipmentId: equipment._id,
          ownerId: req.authUser.id,

          nameSnapshot: equipment.name,
          dailyRentalPriceSnapshot: equipment.dailyPrice,

          ratePercentBase: 1,
          ratePercentCap: 2,
          minimumFeeBDT: 30,

          durationDays: days,
          totalPaisa: quote.amountPaisa,
          currency: "bdt",

          paymentStatus: "unpaid",
          status: "checkout_pending",

          stripeSessionId: null,

          createdAt: now,
          updatedAt: now,
        });

        let checkout;

        try {
          // ==================================
          // Create Stripe Checkout Session
          // ==================================

          checkout = await stripe().checkout.sessions.create(
            {
              mode: "payment",

              client_reference_id: featureId.toString(),

              metadata: {
                kind: "equipment_feature",
                featureId: featureId.toString(),
                equipmentId: equipment._id.toString(),
              },

              line_items: [
                {
                  price_data: {
                    currency: "bdt",

                    unit_amount: quote.amountPaisa,

                    product_data: {
                      name: `GearRento Featured: ${equipment.name}`.slice(
                        0,
                        120,
                      ),
                    },
                  },
                  quantity: 1,
                },
              ],

              success_url:
                `${clientURL}/dashboard/feature-equipment/${equipment._id}` +
                "?payment=success&session_id={CHECKOUT_SESSION_ID}",

              cancel_url:
                `${clientURL}/dashboard/feature-equipment/${equipment._id}` +
                "?payment=cancelled",

              expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
            },
            {
              idempotencyKey: `gearrento-feature-${featureId}`,
            },
          );

          if (!checkout.url) {
            throw new Error("Stripe Checkout URL is missing.");
          }

          // ==================================
          // Store Stripe Session
          // ==================================

          const saved = await features.updateOne(
            {
              _id: featureId,
              status: "checkout_pending",
              stripeSessionId: null,
            },
            {
              $set: {
                stripeSessionId: checkout.id,
                updatedAt: new Date(),
              },
            },
          );

          if (!saved.matchedCount) {
            const latest = await features.findOne({
              _id: featureId,
            });

            if (
              latest?.stripeSessionId !== checkout.id ||
              latest?.paymentStatus !== "paid"
            ) {
              throw new Error("Unable to store Checkout Session.");
            }
          }

          return res.status(201).json({
            success: true,
            url: checkout.url,
            featureId: featureId.toString(),
          });
        } catch (error) {
          console.error("Feature Checkout creation failed:", error);

          if (checkout?.id) {
            try {
              await stripe().checkout.sessions.expire(checkout.id);
            } catch (expireError) {
              console.error("Feature Checkout session cleanup:", expireError);
            }
          }

          await features.updateOne(
            {
              _id: featureId,
              paymentStatus: "unpaid",
              status: "checkout_pending",
            },
            {
              $set: {
                status: "checkout_failed",
                updatedAt: new Date(),
              },
            },
          );

          return res.status(502).json({
            success: false,
            error:
              "Promotion checkout could not be started. Contact support if charged.",
          });
        }
      } catch (error) {
        console.error("Featured checkout preparation:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to prepare promotion checkout.",
        });
      }
    },
  );

  // ====================================
  // GET Featured Payment Status
  // Owner Only
  // ====================================

  // Supports:
  // ?session_id=cs_test_...
  //
  // Also supports older return URLs:
  // ?payment=success

  app.get(
    "/owner/equipment/:id/feature/payment-status",
    ...auth,
    async (req, res) => {
      try {
        const equipmentId = req.params.id;

        if (!validEquipmentId(equipmentId)) {
          return res.status(400).json({
            success: false,
            error: "Invalid equipment ID.",
          });
        }

        const rawSessionId = req.query.session_id;

        if (
          rawSessionId !== undefined &&
          (typeof rawSessionId !== "string" ||
            !/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(rawSessionId))
        ) {
          return res.status(400).json({
            success: false,
            error: "Invalid Checkout Session ID.",
          });
        }

        const db = getDb();

        const features = db.collection("equipmentFeatures");

        const filter = {
          equipmentId: new ObjectId(equipmentId),

          ownerId: {
            $in: idCandidates(req.authUser.id),
          },
        };

        let feature;

        // ==================================
        // Find Purchase
        // ==================================

        if (rawSessionId) {
          feature = await features.findOne({
            ...filter,
            stripeSessionId: rawSessionId,
          });
        } else {
          // For old Checkout redirects,
          // check the most recent pending
          // feature purchase first.

          feature = await features.findOne(
            {
              ...filter,
              status: "checkout_pending",
              stripeSessionId: {
                $type: "string",
              },
            },
            {
              sort: {
                createdAt: -1,
              },
            },
          );

          if (!feature) {
            feature = await features.findOne(
              {
                ...filter,
                stripeSessionId: {
                  $type: "string",
                },
              },
              {
                sort: {
                  createdAt: -1,
                },
              },
            );
          }
        }

        if (!feature) {
          return res.status(404).json({
            success: false,
            error: "Feature purchase not found.",
          });
        }

        // ==================================
        // Reconcile Payment with Stripe
        // ==================================

        if (feature.paymentStatus !== "paid") {
          const checkout = await stripe().checkout.sessions.retrieve(
            feature.stripeSessionId,
          );

          if (
            checkout.status === "complete" &&
            checkout.payment_status === "paid"
          ) {
            // Stripe Session is retrieved
            // using the server's secret key.
            // Reuse the transaction-safe
            // activation handler.

            await handleFeatureCheckoutWebhook(db, getMongoClient(), {
              type: "checkout.session.completed",
              data: {
                object: checkout,
              },
            });
          } else if (checkout.status === "expired") {
            await handleFeatureCheckoutWebhook(db, getMongoClient(), {
              type: "checkout.session.expired",
              data: {
                object: checkout,
              },
            });
          }

          feature = await features.findOne({
            _id: feature._id,
          });
        }

        // ==================================
        // Read Equipment Feature Expiry
        // ==================================

        const equipment = await db.collection("equipment").findOne(
          {
            _id: new ObjectId(equipmentId),

            ownerId: {
              $in: idCandidates(req.authUser.id),
            },
          },
          {
            projection: {
              featureExpiresAt: 1,
              status: 1,
            },
          },
        );

        if (!equipment) {
          return res.status(404).json({
            success: false,
            error: "Equipment not found.",
          });
        }

        const expiresAt = equipment.featureExpiresAt;

        const isFeatured =
          equipment.status === "approved" &&
          expiresAt instanceof Date &&
          expiresAt.getTime() > Date.now();

        res.set("Cache-Control", "no-store");

        return res.status(200).json({
          success: true,

          status: feature?.status ?? null,

          paymentStatus: feature?.paymentStatus ?? null,

          isFeatured,

          featureExpiresAt: expiresAt ?? null,

          durationDays: feature?.durationDays ?? null,
        });
      } catch (error) {
        console.error("Feature payment verification failed:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to verify featured payment.",
        });
      }
    },
  );
}

// ======================================
// Stripe Webhook Payment Handler
// ======================================

// Called after Stripe signature verification,
// or after an authenticated owner status
// endpoint retrieves a session from Stripe.
//
// Both paths use the same activation logic.

export async function handleFeatureCheckoutWebhook(db, mongoClient, event) {
  const checkout = event.data?.object;

  if (checkout?.metadata?.kind !== "equipment_feature") {
    return false;
  }

  const allowedEvents = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ];

  if (!allowedEvents.includes(event.type)) {
    return true;
  }

  const featureId = checkout.metadata.featureId;

  // ====================================
  // Validate Payment Reference
  // ====================================

  if (
    !validEquipmentId(featureId) ||
    checkout.client_reference_id !== featureId
  ) {
    throw new Error("Featured payment reference mismatch.");
  }

  const features = db.collection("equipmentFeatures");

  const featureObjectId = new ObjectId(featureId);

  const feature = await features.findOne({
    _id: featureObjectId,
  });

  if (!feature) {
    throw new Error(`Missing feature payment record: ${featureId}`);
  }

  if (feature.equipmentId.toString() !== checkout.metadata.equipmentId) {
    throw new Error("Featured equipment ID mismatch.");
  }

  if (feature.stripeSessionId && feature.stripeSessionId !== checkout.id) {
    throw new Error("Featured Stripe Session mismatch.");
  }

  const paidEvent = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ].includes(event.type);

  // ====================================
  // Activate After Verified Payment
  // ====================================

  if (paidEvent && checkout.payment_status === "paid") {
    if (
      checkout.mode !== "payment" ||
      checkout.status !== "complete" ||
      checkout.currency !== "bdt" ||
      checkout.amount_total !== feature.totalPaisa
    ) {
      throw new Error(
        `Featured payment amount/currency mismatch: ${featureId}`,
      );
    }

    const mongoSession = mongoClient.startSession();

    try {
      await mongoSession.withTransaction(
        async () => {
          const current = await features.findOne(
            {
              _id: featureObjectId,
            },
            {
              session: mongoSession,
            },
          );

          // Already processed.
          // Never activate the same payment twice.

          if (!current || current.paymentStatus === "paid") {
            return;
          }

          const now = new Date();

          // ==================================
          // Lock Equipment During Activation
          // ==================================

          const equipment = await db.collection("equipment").findOneAndUpdate(
            {
              _id: current.equipmentId,

              ownerId: {
                $in: idCandidates(current.ownerId),
              },

              status: "approved",
            },
            {
              $inc: {
                featureLockVersion: 1,
              },
            },
            {
              session: mongoSession,
              returnDocument: "after",
            },
          );

          // ==================================
          // Payment Received But Ineligible
          // ==================================

          if (!equipment) {
            const result = await features.updateOne(
              {
                _id: featureObjectId,
                paymentStatus: "unpaid",
              },
              {
                $set: {
                  status: "paid_review",

                  paymentStatus: "paid",

                  stripeSessionId: checkout.id,

                  paidAt: now,
                  updatedAt: now,
                },
              },
              {
                session: mongoSession,
              },
            );

            if (!result.matchedCount) {
              throw new Error("Feature payment update conflict.");
            }

            return;
          }

          // ==================================
          // Calculate Feature Expiration
          // ==================================

          const previousExpiry =
            equipment.featureExpiresAt instanceof Date
              ? equipment.featureExpiresAt.getTime()
              : 0;

          // Existing promotions are extended,
          // not overwritten.

          const startsAt = new Date(Math.max(now.getTime(), previousExpiry));

          const expiresAt = new Date(
            startsAt.getTime() + current.durationDays * DAY_MS,
          );

          // ==================================
          // Update Feature Purchase
          // ==================================

          const paymentResult = await features.updateOne(
            {
              _id: featureObjectId,
              paymentStatus: "unpaid",
            },
            {
              $set: {
                status: "active",

                paymentStatus: "paid",

                stripeSessionId: checkout.id,

                paidAt: now,
                startsAt,
                expiresAt,

                updatedAt: now,
              },
            },
            {
              session: mongoSession,
            },
          );

          if (!paymentResult.matchedCount) {
            throw new Error("Feature activation conflict.");
          }

          // ==================================
          // Update Equipment Featured Expiry
          // ==================================

          const equipmentResult = await db.collection("equipment").updateOne(
            {
              _id: current.equipmentId,
            },
            {
              $set: {
                featureExpiresAt: expiresAt,

                updatedAt: now,
              },
            },
            {
              session: mongoSession,
            },
          );

          if (!equipmentResult.matchedCount) {
            throw new Error("Equipment promotion update failed.");
          }
        },
        {
          readConcern: {
            level: "snapshot",
          },

          writeConcern: {
            w: "majority",
          },
        },
      );
    } finally {
      await mongoSession.endSession();
    }

    return true;
  }

  // ====================================
  // Expired or Failed Checkout
  // ====================================

  if (
    event.type === "checkout.session.expired" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    await features.updateOne(
      {
        _id: featureObjectId,

        paymentStatus: "unpaid",

        status: "checkout_pending",
      },
      {
        $set: {
          status:
            event.type === "checkout.session.expired"
              ? "expired"
              : "payment_failed",

          stripeSessionId: checkout.id,

          updatedAt: new Date(),
        },
      },
    );
  }

  return true;
}
