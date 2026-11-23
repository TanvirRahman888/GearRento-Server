import Stripe from "stripe";
import { ObjectId } from "mongodb";

const DURATIONS = [5, 15, 30];
const MIN_FEE_PAISA = 3000; // ৳30
const DAY_MS = 86400000;

let stripeClient;

function stripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();

    if (!key?.startsWith("sk_test_")) {
      throw new Error("Stripe Sandbox requires STRIPE_SECRET_KEY=sk_test_...");
    }

    stripeClient = new Stripe(key);
  }

  return stripeClient;
}

function idCandidates(value) {
  const values = [value];

  if (/^[0-9a-f]{24}$/i.test(value)) {
    values.push(new ObjectId(value));
  }

  return values;
}

function validEquipmentId(id) {
  return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);
}

// ======================================
// Server-Side Promotion Pricing
// ======================================

function calculateQuote(dailyPrice, days) {
  const dailyPaisa = Math.round(Number(dailyPrice) * 100);

  if (!Number.isSafeInteger(dailyPaisa) || dailyPaisa <= 0) {
    return null;
  }

  // Standard rate: 1% per feature-day.
  const basePaisa = Math.round((dailyPaisa * days) / 100);

  // Maximum effective rate: 2%.
  const capPaisa = Math.floor((dailyPaisa * days * 2) / 100);

  // Minimum total charge: ৳30.
  const configuredMinimumBDT = Number(process.env.STRIPE_FEATURE_MIN_BDT || 0);

  if (!Number.isFinite(configuredMinimumBDT) || configuredMinimumBDT < 0) {
    throw new Error("Invalid STRIPE_FEATURE_MIN_BDT.");
  }

  const stripeMinimumPaisa = Math.round(configuredMinimumBDT * 100);

  const amountPaisa = Math.max(MIN_FEE_PAISA, basePaisa, stripeMinimumPaisa);

  if (!Number.isSafeInteger(amountPaisa) || amountPaisa > 99999999) {
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
// Owner Routes
// ======================================

export function registerFeaturedEquipmentRoutes(
  app,
  { getDb, verifyJWT, requireRole },
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

        const featureId = new ObjectId();
        const now = new Date();

        const features = db.collection("equipmentFeatures");

        // Save a price snapshot before
        // starting Stripe Checkout.
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
                "?payment=success",

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

          await features.updateOne(
            {
              _id: featureId,
              status: "checkout_pending",
            },
            {
              $set: {
                stripeSessionId: checkout.id,
                updatedAt: new Date(),
              },
            },
          );

          return res.status(201).json({
            success: true,
            url: checkout.url,
            featureId: featureId.toString(),
          });
        } catch (error) {
          console.error("FEATURE CHECKOUT FAILED:", {
            featureId: featureId.toString(),
            equipmentId: equipment._id.toString(),
            durationDays: days,
            amountPaisa: quote.amountPaisa,

            // Did Stripe create a Session?
            stripeSessionId: checkout?.id || null,

            // Actual error information
            type: error?.type,
            code: error?.code,
            statusCode: error?.statusCode,
            message: error?.message,
          });

          const stripeMessage =
            typeof error?.message === "string" ? error.message : "";

          // Stripe may reject a payment that is
          // below the account's minimum charge.
          const belowMinimum =
            error?.code === "amount_too_small" ||
            /minimum|too small|at least|convert to/i.test(stripeMessage);

          if (belowMinimum && !checkout?.id) {
            return res.status(400).json({
              success: false,
              error:
                "This promotion fee is below Stripe's minimum charge. Please select a longer duration.",
            });
          }

          return res.status(502).json({
            success: false,
            error:
              "Promotion payment could not be started safely. Please contact support if charged.",
          });
        }
      } catch (error) {
        console.error("Featured Checkout error:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to prepare promotion checkout.",
        });
      }
    },
  );
}

// ======================================
// Stripe Webhook Payment Handler
// Called after Stripe signature verification
// ======================================

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

  const paidEvent =
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded";

  // ====================================
  // Activate After Verified Payment
  // ====================================

  if (paidEvent && checkout.payment_status === "paid") {
    if (
      checkout.mode !== "payment" ||
      checkout.currency !== "bdt" ||
      checkout.amount_total !== feature.totalPaisa
    ) {
      throw new Error(
        `Featured payment amount/currency mismatch: ${featureId}`,
      );
    }

    const session = mongoClient.startSession();

    try {
      await session.withTransaction(
        async () => {
          const current = await features.findOne(
            {
              _id: featureObjectId,
            },
            { session },
          );

          // Already processed successfully.
          // Never activate twice.
          if (!current || current.paymentStatus === "paid") {
            return;
          }

          const now = new Date();

          // Write-lock the equipment so
          // simultaneous paid promotions
          // extend rather than overwrite.
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
              session,
              returnDocument: "after",
            },
          );

          // An equipment item can be
          // rejected between Checkout
          // creation and payment.
          if (!equipment) {
            await features.updateOne(
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
              { session },
            );

            return;
          }

          const previousExpiry =
            equipment.featureExpiresAt instanceof Date
              ? equipment.featureExpiresAt.getTime()
              : 0;

          // A second purchase extends an
          // existing feature period.
          const startsAt = new Date(Math.max(now.getTime(), previousExpiry));

          const expiresAt = new Date(
            startsAt.getTime() + current.durationDays * DAY_MS,
          );

          await features.updateOne(
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
            { session },
          );

          await db.collection("equipment").updateOne(
            {
              _id: current.equipmentId,
            },
            {
              $set: {
                featureExpiresAt: expiresAt,
                updatedAt: now,
              },
            },
            { session },
          );
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
      await session.endSession();
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
