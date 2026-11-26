import express from "express";
import Stripe from "stripe";
import { ObjectId } from "mongodb";

import { getPlatformSettings } from "./platform-settings.js";
import { handleFeatureCheckoutWebhook } from "./featured-equipment.js";

// ======================================
// Configuration
// ======================================

const DAY_MS = 86400000;

const divisions = [
  "Dhaka",
  "Chattogram",
  "Rajshahi",
  "Khulna",
  "Barishal",
  "Sylhet",
  "Rangpur",
  "Mymensingh",
];

const objectIdPattern = /^[a-f0-9]{24}$/i;

let stripeInstance;

// ======================================
// Stripe Client
// ======================================

function getStripe() {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();

    if (!key?.startsWith("sk_test_")) {
      throw new Error("STRIPE_SECRET_KEY must be a valid sk_test_ key.");
    }

    stripeInstance = new Stripe(key);
  }

  return stripeInstance;
}

// ======================================
// General Helpers
// ======================================

function cleanText(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date
    : null;
}

function todayInBangladesh() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function pagination(req) {
  const raw = Number(req.query.page ?? 1);

  const page = Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 100000) : 1;

  return {
    page,
    limit: 10,
    skip: (page - 1) * 10,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isConfirmed(booking, sessionId) {
  return (
    booking?.stripeSessionId === sessionId &&
    booking.paymentStatus === "paid" &&
    ["confirmed", "completed"].includes(booking.status)
  );
}

// ======================================
// Booking Error
// ======================================

class BookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ======================================
// Verified Payment Fulfillment
// ======================================

// Shared by Stripe webhook and authenticated
// booking status endpoint.
//
// Only call with:
// 1. A signature-verified Stripe webhook, or
// 2. A Session retrieved using the server-side
//    Stripe secret API key.
//
// Uses conditional MongoDB updates to prevent
// duplicate payment confirmations.

async function confirmPaidCheckout(db, checkout, customerId = null) {
  const bookingId = checkout.metadata?.bookingId;

  // ====================================
  // Verify Booking Identity
  // ====================================

  if (
    !objectIdPattern.test(bookingId ?? "") ||
    checkout.client_reference_id !== bookingId
  ) {
    throw new Error("Checkout booking identity mismatch.");
  }

  const bookings = db.collection("bookings");

  const filter = {
    _id: new ObjectId(bookingId),

    ...(customerId ? { customerId } : {}),
  };

  let booking = await bookings.findOne(filter);

  if (!booking) {
    throw new Error("Booking not found.");
  }

  // ====================================
  // Verify Checkout Session
  // ====================================

  if (booking.stripeSessionId && booking.stripeSessionId !== checkout.id) {
    throw new Error("Checkout Session does not match booking.");
  }

  // ====================================
  // Verify Price and Currency
  // ====================================

  if (
    checkout.mode !== "payment" ||
    checkout.currency !== "bdt" ||
    checkout.amount_total !== booking.totalPaisa
  ) {
    throw new Error("Stripe payment amount or currency mismatch.");
  }

  // ====================================
  // Already Confirmed
  // ====================================

  if (isConfirmed(booking, checkout.id)) {
    return booking;
  }

  // ====================================
  // Check Payment Status
  // ====================================

  if (checkout.status !== "complete" || checkout.payment_status !== "paid") {
    return booking;
  }

  // ====================================
  // Update Booking Atomically
  // ====================================

  const now = new Date();

  await bookings.updateOne(
    {
      ...filter,

      status: "checkout_pending",
      paymentStatus: "unpaid",

      $or: [{ stripeSessionId: checkout.id }, { stripeSessionId: null }],
    },
    {
      $set: {
        stripeSessionId: checkout.id,

        status: "confirmed",
        paymentStatus: "paid",

        stripePaymentIntentId:
          typeof checkout.payment_intent === "string"
            ? checkout.payment_intent
            : (checkout.payment_intent?.id ?? null),

        paidAt: now,
        updatedAt: now,
      },
    },
  );

  // ====================================
  // Verify Database Update
  // ====================================

  booking = await bookings.findOne(filter);

  if (!isConfirmed(booking, checkout.id)) {
    throw new Error("Paid Checkout Session could not confirm the booking.");
  }

  return booking;
}

// ======================================
// STRIPE WEBHOOK
// POST /stripe/webhook
// ======================================

// IMPORTANT:
// Register this route before express.json()
// in src/index.js.

export function registerStripeWebhook(app, getDb, getMongoClient) {
  app.post(
    "/stripe/webhook",

    express.raw({
      type: "application/json",
    }),

    async (req, res) => {
      let event;

      // ==================================
      // Verify Stripe Signature
      // ==================================

      try {
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
          throw new Error("STRIPE_WEBHOOK_SECRET is missing.");
        }

        event = getStripe().webhooks.constructEvent(
          req.body,
          req.get("stripe-signature"),
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch (error) {
        console.error("Stripe signature verification:", error.message);

        return res.status(400).send("Invalid Stripe signature");
      }

      // ==================================
      // Supported Stripe Events
      // ==================================

      const accepted = [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
      ];

      if (!accepted.includes(event.type)) {
        return res.json({
          received: true,
        });
      }

      const checkout = event.data.object;

      try {
        // ==================================
        // Featured Equipment Payment
        // ==================================

        if (checkout.metadata?.kind === "equipment_feature") {
          await handleFeatureCheckoutWebhook(getDb(), getMongoClient(), event);

          return res.json({
            received: true,
          });
        }

        // ==================================
        // Rental Booking Payment
        // ==================================

        const bookingId = checkout.metadata?.bookingId;

        if (
          !objectIdPattern.test(bookingId ?? "") ||
          checkout.client_reference_id !== bookingId
        ) {
          return res.json({
            received: true,
          });
        }

        const bookings = getDb().collection("bookings");

        const booking = await bookings.findOne({
          _id: new ObjectId(bookingId),
        });

        if (!booking) {
          throw new Error(`Webhook booking not found: ${bookingId}`);
        }

        if (
          booking.stripeSessionId &&
          booking.stripeSessionId !== checkout.id
        ) {
          throw new Error("Webhook Checkout Session mismatch.");
        }

        // ==================================
        // Successful Payment Events
        // ==================================

        if (
          [
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
          ].includes(event.type)
        ) {
          if (checkout.payment_status === "paid") {
            await confirmPaidCheckout(getDb(), checkout);

            console.info("Stripe rental payment confirmed:", {
              bookingId,
              sessionId: checkout.id,
            });
          }
        } else {
          // ==================================
          // Failed or Expired Checkout
          // ==================================

          const status =
            event.type === "checkout.session.expired"
              ? "expired"
              : "payment_failed";

          await bookings.updateOne(
            {
              _id: booking._id,

              status: "checkout_pending",
              paymentStatus: "unpaid",

              $or: [
                { stripeSessionId: checkout.id },
                { stripeSessionId: null },
              ],
            },
            {
              $set: {
                stripeSessionId: checkout.id,
                status,
                updatedAt: new Date(),
              },
            },
          );
        }

        return res.json({
          received: true,
        });
      } catch (error) {
        console.error("Stripe webhook processing error:", error);

        // Return 500 so Stripe can retry
        // failed webhook processing.

        return res.status(500).send("Webhook processing failed");
      }
    },
  );
}

// ======================================
// REGISTER BOOKING ROUTES
// ======================================

export function registerBookingRoutes(
  app,
  { getDb, getMongoClient, verifyJWT, requireRole },
) {
  // ====================================
  // POST /bookings/checkout
  // Customer Only
  // ====================================

  app.post(
    "/bookings/checkout",

    verifyJWT,
    requireRole("customer"),

    async (req, res) => {
      const db = getDb();

      const equipmentCollection = db.collection("equipment");

      const bookings = db.collection("bookings");

      const { equipmentId, startDate, endDate, quantity } = req.body ?? {};

      const fullName = cleanText(req.body?.fullName, 100);

      const phone = cleanText(req.body?.phone, 30);

      const address = cleanText(req.body?.address, 500);

      const district = cleanText(req.body?.district, 100);

      const division = cleanText(req.body?.division, 40);

      const notes = cleanText(req.body?.notes, 500);

      // ==================================
      // Validate Equipment ID
      // ==================================

      if (!objectIdPattern.test(equipmentId ?? "")) {
        return res.status(400).json({
          error: "Invalid equipment ID.",
        });
      }

      // ==================================
      // Validate Rental Dates
      // ==================================

      const start = parseDate(startDate);
      const end = parseDate(endDate);

      if (
        !start ||
        !end ||
        startDate < todayInBangladesh() ||
        endDate < startDate
      ) {
        return res.status(400).json({
          error: "Select valid rental dates.",
        });
      }

      const totalDays =
        Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;

      // ==================================
      // Platform Booking Settings
      // ==================================

      let settings;

      try {
        settings = await getPlatformSettings(db);
      } catch (error) {
        console.error("Booking settings:", error);

        return res.status(503).json({
          error: "Booking service temporarily unavailable.",
        });
      }

      if (!settings.bookingsEnabled) {
        return res.status(503).json({
          error: "New bookings are temporarily paused.",
        });
      }

      if (totalDays < 1 || totalDays > settings.maxRentalDays) {
        return res.status(400).json({
          error: `Rental duration must be 1-${settings.maxRentalDays} days.`,
        });
      }

      // ==================================
      // Validate Quantity
      // ==================================

      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
        return res.status(400).json({
          error: "Invalid rental quantity.",
        });
      }

      // ==================================
      // Validate Customer Information
      // ==================================

      if (
        fullName.length < 2 ||
        address.length < 10 ||
        !/^\+?[0-9][0-9\s-]{8,18}$/.test(phone) ||
        district.length < 2 ||
        !divisions.includes(division)
      ) {
        return res.status(400).json({
          error: "Enter valid delivery and contact details.",
        });
      }

      // ==================================
      // Reserve Equipment
      // ==================================

      let bookingId;
      let equipment;

      const mongoSession = getMongoClient().startSession();

      try {
        bookingId = await mongoSession.withTransaction(
          async () => {
            const id = new ObjectId(equipmentId);

            // Lock equipment document to
            // serialize competing reservations.

            const locked = await equipmentCollection.updateOne(
              {
                _id: id,

                status: "approved",

                availableQuantity: {
                  $gte: quantity,
                },
              },
              {
                $inc: {
                  bookingLockVersion: 1,
                },
              },
              {
                session: mongoSession,
              },
            );

            if (!locked.matchedCount) {
              throw new BookingError("Equipment is unavailable.", 409);
            }

            equipment = await equipmentCollection.findOne(
              { _id: id },
              {
                session: mongoSession,
              },
            );

            // ==================================
            // Validate Rental Division
            // ==================================

            if (!equipment.divisions?.includes(division)) {
              throw new BookingError(
                "Equipment is not available in that division.",
                409,
              );
            }

            // ==================================
            // Check Owner Blocked Dates
            // ==================================

            const blocked = new Set(equipment.blockedDates ?? []);

            for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
              const day = new Date(t).toISOString().slice(0, 10);

              if (blocked.has(day)) {
                throw new BookingError(`Unavailable on ${day}.`, 409);
              }
            }

            // ==================================
            // Calculate Rental Price
            // ==================================

            const pricePaisa = Math.round(Number(equipment.dailyPrice) * 100);

            const totalPaisa = pricePaisa * totalDays * quantity;

            if (
              !Number.isSafeInteger(pricePaisa) ||
              pricePaisa <= 0 ||
              !Number.isSafeInteger(totalPaisa) ||
              totalPaisa > 99999999
            ) {
              throw new BookingError("Invalid rental price.");
            }

            // ==================================
            // Find Overlapping Reservations
            // ==================================

            const active = await bookings
              .find(
                {
                  equipmentId: id,

                  startDate: {
                    $lte: endDate,
                  },

                  endDate: {
                    $gte: startDate,
                  },

                  status: {
                    $in: ["checkout_pending", "confirmed"],
                  },
                },
                {
                  session: mongoSession,
                },
              )
              .project({
                startDate: 1,
                endDate: 1,
                quantity: 1,
              })
              .toArray();

            // ==================================
            // Daily Inventory Check
            // ==================================

            for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
              const day = new Date(t).toISOString().slice(0, 10);

              const occupied = active.reduce(
                (sum, booking) =>
                  sum +
                  (booking.startDate <= day && booking.endDate >= day
                    ? booking.quantity
                    : 0),
                0,
              );

              if (occupied + quantity > equipment.availableQuantity) {
                throw new BookingError(
                  `Not enough units available on ${day}.`,
                  409,
                );
              }
            }

            // ==================================
            // Create Pending Booking
            // ==================================

            const now = new Date();

            const result = await bookings.insertOne(
              {
                equipmentId: id,

                ownerId: equipment.ownerId,

                customerId: req.authUser.id,

                equipmentName: equipment.name,

                imageUrl: equipment.imageUrls?.[0] ?? "",

                startDate,
                endDate,
                totalDays,
                quantity,

                dailyPrice: equipment.dailyPrice,

                totalPaisa,

                totalPrice: totalPaisa / 100,

                currency: "bdt",

                fullName,
                phone,
                address,
                district,
                division,
                notes,

                status: "checkout_pending",

                paymentStatus: "unpaid",

                stripeSessionId: null,

                createdAt: now,
                updatedAt: now,
              },
              {
                session: mongoSession,
              },
            );

            return result.insertedId.toString();
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
      } catch (error) {
        console.error("Booking transaction:", error);

        return res
          .status(error instanceof BookingError ? error.status : 500)
          .json({
            error:
              error instanceof BookingError
                ? error.message
                : "Unable to reserve equipment.",
          });
      } finally {
        await mongoSession.endSession();
      }

      // ==================================
      // Create Stripe Checkout Session
      // ==================================

      let checkout;

      try {
        const clientURL = process.env.CLIENT_URL?.replace(/\/+$/, "");

        if (!clientURL) {
          throw new Error("Missing CLIENT_URL");
        }

        const booking = await bookings.findOne({
          _id: new ObjectId(bookingId),
        });

        checkout = await getStripe().checkout.sessions.create(
          {
            mode: "payment",

            client_reference_id: bookingId,

            metadata: {
              bookingId,
            },

            line_items: [
              {
                price_data: {
                  currency: "bdt",

                  product_data: {
                    name: equipment.name.slice(0, 120),
                  },

                  unit_amount: Math.round(booking.dailyPrice * 100),
                },

                quantity: totalDays * quantity,
              },
            ],

            success_url: `${clientURL}/booking/success?session_id={CHECKOUT_SESSION_ID}`,

            cancel_url: `${clientURL}/booking/cancel?booking_id=${bookingId}`,

            expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          },
          {
            idempotencyKey: `gearrento-booking-${bookingId}`,
          },
        );

        if (!checkout.url) {
          throw new Error("Stripe Checkout URL missing.");
        }

        // ==================================
        // Store Stripe Session ID
        // ==================================

        const saved = await bookings.updateOne(
          {
            _id: new ObjectId(bookingId),

            stripeSessionId: null,

            status: "checkout_pending",
          },
          {
            $set: {
              stripeSessionId: checkout.id,

              checkoutExpiresAt: new Date(checkout.expires_at * 1000),

              updatedAt: new Date(),
            },
          },
        );

        // Stripe might complete a webhook
        // before this update in rare cases.

        if (!saved.matchedCount) {
          const current = await bookings.findOne({
            _id: new ObjectId(bookingId),
          });

          if (!isConfirmed(current, checkout.id)) {
            throw new Error("Unable to save Checkout Session.");
          }
        }

        return res.status(201).json({
          success: true,
          bookingId,
          url: checkout.url,
        });
      } catch (error) {
        console.error("Stripe Checkout creation:", error);

        // ==================================
        // Expire Unused Checkout Session
        // ==================================

        if (checkout?.id) {
          try {
            await getStripe().checkout.sessions.expire(checkout.id);
          } catch (expireError) {
            console.error("Session cleanup:", expireError);
          }
        }

        await bookings.updateOne(
          {
            _id: new ObjectId(bookingId),

            stripeSessionId: null,

            status: "checkout_pending",
          },
          {
            $set: {
              status: "checkout_failed",
              updatedAt: new Date(),
            },
          },
        );

        return res.status(500).json({
          error: "Unable to start Stripe Checkout.",
        });
      }
    },
  );

  // ====================================
  // GET /bookings/mine
  // Customer Only
  // ====================================

  app.get(
    "/bookings/mine",

    verifyJWT,
    requireRole("customer"),

    async (req, res) => {
      try {
        const { page, limit, skip } = pagination(req);

        const collection = getDb().collection("bookings");

        const filter = {
          customerId: req.authUser.id,
        };

        const [total, bookings] = await Promise.all([
          collection.countDocuments(filter),

          collection
            .find(filter, {
              projection: {
                equipmentId: 1,
                equipmentName: 1,
                imageUrl: 1,

                startDate: 1,
                endDate: 1,
                totalDays: 1,
                quantity: 1,

                dailyPrice: 1,
                totalPrice: 1,
                currency: 1,

                status: 1,
                paymentStatus: 1,
                createdAt: 1,
              },
            })
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(skip)
            .limit(limit)
            .toArray(),
        ]);

        return res.json({
          success: true,

          bookings: bookings.map((b) => ({
            ...b,

            _id: b._id.toString(),

            equipmentId: b.equipmentId?.toString() ?? "",
          })),

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("My bookings:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to load your bookings.",
        });
      }
    },
  );

  // ====================================
  // GET /bookings/session/:sessionId
  // Customer Payment Verification
  // ====================================

  app.get(
    "/bookings/session/:sessionId",

    verifyJWT,
    requireRole("customer"),

    async (req, res) => {
      try {
        const { sessionId } = req.params;

        // ==================================
        // Validate Session ID
        // ==================================

        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
          return res.status(400).json({
            success: false,
            error: "Invalid Checkout Session ID.",
          });
        }

        const db = getDb();

        let booking = await db.collection("bookings").findOne({
          customerId: req.authUser.id,

          stripeSessionId: sessionId,
        });

        if (!booking) {
          return res.status(404).json({
            success: false,
            error: "Booking not found.",
          });
        }

        // ==================================
        // Reconcile Pending Payment
        // ==================================

        if (
          booking.status === "checkout_pending" &&
          booking.paymentStatus !== "paid"
        ) {
          const checkout =
            await getStripe().checkout.sessions.retrieve(sessionId);

          if (
            checkout.status === "complete" &&
            checkout.payment_status === "paid"
          ) {
            booking = await confirmPaidCheckout(db, checkout, req.authUser.id);
          }
        }

        // ==================================
        // Return Latest Booking Status
        // ==================================

        res.set("Cache-Control", "no-store");

        return res.json({
          success: true,

          status: booking.status,

          paymentStatus: booking.paymentStatus,

          confirmed: isConfirmed(booking, sessionId),

          equipmentName: booking.equipmentName,

          totalPrice: booking.totalPrice,

          currency: booking.currency,
        });
      } catch (error) {
        console.error("Booking payment reconciliation:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to verify booking payment.",
        });
      }
    },
  );

  // ====================================
  // GET /bookings/owner
  // Owner Rental Bookings
  // ====================================

  app.get(
    "/bookings/owner",

    verifyJWT,
    requireRole("owner"),

    async (req, res) => {
      try {
        const { page, limit, skip } = pagination(req);

        const requestedStatus = cleanText(req.query.status, 30);

        const status = ["all", "confirmed", "completed"].includes(
          requestedStatus,
        )
          ? requestedStatus
          : "all";

        const filter = {
          ownerId: req.authUser.id,

          paymentStatus: "paid",

          status:
            status === "all"
              ? {
                  $in: ["confirmed", "completed"],
                }
              : status,
        };

        const collection = getDb().collection("bookings");

        const [total, confirmedCount, completedCount, bookings] =
          await Promise.all([
            collection.countDocuments(filter),

            collection.countDocuments({
              ownerId: req.authUser.id,
              paymentStatus: "paid",
              status: "confirmed",
            }),

            collection.countDocuments({
              ownerId: req.authUser.id,
              paymentStatus: "paid",
              status: "completed",
            }),

            collection
              .find(filter, {
                projection: {
                  equipmentId: 1,
                  equipmentName: 1,
                  imageUrl: 1,
                  customerId: 1,

                  fullName: 1,
                  phone: 1,
                  division: 1,
                  district: 1,
                  address: 1,
                  notes: 1,

                  startDate: 1,
                  endDate: 1,
                  totalDays: 1,
                  quantity: 1,

                  dailyPrice: 1,
                  totalPrice: 1,
                  currency: 1,

                  status: 1,
                  paymentStatus: 1,

                  createdAt: 1,
                  completedAt: 1,
                },
              })
              .sort({
                createdAt: -1,
                _id: -1,
              })
              .skip(skip)
              .limit(limit)
              .toArray(),
          ]);

        return res.json({
          success: true,

          bookings: bookings.map((b) => ({
            ...b,

            _id: b._id.toString(),

            equipmentId: b.equipmentId?.toString() ?? "",
          })),

          stats: {
            total: confirmedCount + completedCount,

            confirmed: confirmedCount,
            completed: completedCount,
          },

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("Owner bookings:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to load rental bookings.",
        });
      }
    },
  );

  // ====================================
  // PATCH /bookings/owner/:id/complete
  // Owner Only
  // ====================================

  app.patch(
    "/bookings/owner/:id/complete",

    verifyJWT,
    requireRole("owner"),

    async (req, res) => {
      try {
        if (!objectIdPattern.test(req.params.id)) {
          return res.status(400).json({
            success: false,
            error: "Invalid booking ID.",
          });
        }

        const result = await getDb()
          .collection("bookings")
          .updateOne(
            {
              _id: new ObjectId(req.params.id),

              ownerId: req.authUser.id,

              status: "confirmed",

              paymentStatus: "paid",

              endDate: {
                $lt: todayInBangladesh(),
              },
            },
            {
              $set: {
                status: "completed",

                completedAt: new Date(),

                updatedAt: new Date(),
              },
            },
          );

        if (!result.matchedCount) {
          return res.status(409).json({
            success: false,

            error:
              "Booking not eligible for completion. Check ownership, payment and end date.",
          });
        }

        return res.json({
          success: true,

          message: "Rental marked as completed.",
        });
      } catch (error) {
        console.error("Complete rental:", error);

        return res.status(500).json({
          success: false,

          error: "Unable to complete rental.",
        });
      }
    },
  );

  // ====================================
  // GET /bookings/admin
  // Admin All Rentals
  // ====================================

  app.get(
    "/bookings/admin",

    verifyJWT,
    requireRole("admin"),

    async (req, res) => {
      try {
        const { page, limit, skip } = pagination(req);

        const getQuery = (key) => cleanText(req.query[key], 100);

        const allowedStatuses = [
          "all",
          "checkout_pending",
          "confirmed",
          "completed",
          "checkout_failed",
          "payment_failed",
          "expired",
          "cancelled",
        ];

        const allowedPayments = ["all", "paid", "unpaid"];

        const status = allowedStatuses.includes(getQuery("status"))
          ? getQuery("status")
          : "all";

        const payment = allowedPayments.includes(getQuery("payment"))
          ? getQuery("payment")
          : "all";

        const search = getQuery("q");

        const filter = {};

        // ==================================
        // Admin Filters
        // ==================================

        if (status !== "all") {
          filter.status = status;
        }

        if (payment !== "all") {
          filter.paymentStatus = payment;
        }

        if (search) {
          const regex = {
            $regex: escapeRegex(search),
            $options: "i",
          };

          filter.$or = [
            { equipmentName: regex },
            { fullName: regex },
            { phone: regex },
          ];

          if (objectIdPattern.test(search)) {
            filter.$or.push({
              _id: new ObjectId(search),
            });
          }
        }

        const collection = getDb().collection("bookings");

        // ==================================
        // Fetch Bookings and Statistics
        // ==================================

        const [
          total,
          bookings,
          totalBookings,
          paidBookings,
          confirmedBookings,
          completedBookings,
          paidSums,
        ] = await Promise.all([
          collection.countDocuments(filter),

          collection
            .find(filter, {
              projection: {
                equipmentId: 1,
                equipmentName: 1,
                imageUrl: 1,

                ownerId: 1,
                customerId: 1,

                fullName: 1,
                phone: 1,
                division: 1,
                district: 1,
                address: 1,
                notes: 1,

                startDate: 1,
                endDate: 1,
                totalDays: 1,
                quantity: 1,

                dailyPrice: 1,
                totalPrice: 1,
                currency: 1,

                status: 1,
                paymentStatus: 1,

                stripeSessionId: 1,

                createdAt: 1,
                paidAt: 1,
                completedAt: 1,
              },
            })
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(skip)
            .limit(limit)
            .toArray(),

          collection.countDocuments({}),

          collection.countDocuments({
            paymentStatus: "paid",
          }),

          collection.countDocuments({
            paymentStatus: "paid",
            status: "confirmed",
          }),

          collection.countDocuments({
            paymentStatus: "paid",
            status: "completed",
          }),

          collection
            .aggregate([
              {
                $match: {
                  paymentStatus: "paid",
                  currency: "bdt",
                },
              },
              {
                $group: {
                  _id: null,

                  totalPaisa: {
                    $sum: {
                      $ifNull: ["$totalPaisa", 0],
                    },
                  },
                },
              },
            ])
            .toArray(),
        ]);

        return res.json({
          success: true,

          bookings: bookings.map((b) => ({
            ...b,

            _id: b._id.toString(),

            equipmentId: b.equipmentId?.toString() ?? "",

            ownerId: b.ownerId?.toString() ?? "",

            customerId: b.customerId?.toString() ?? "",
          })),

          stats: {
            totalBookings,
            paidBookings,
            confirmedBookings,
            completedBookings,

            grossPaidAmount: (paidSums[0]?.totalPaisa ?? 0) / 100,
          },

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("Admin bookings:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to load rental bookings.",
        });
      }
    },
  );

  // ====================================
  // GET /bookings/admin/analytics
  // Admin Only
  // ====================================

  app.get(
    "/bookings/admin/analytics",

    verifyJWT,
    requireRole("admin"),

    async (req, res) => {
      try {
        const collection = getDb().collection("bookings");

        const paidFilter = {
          paymentStatus: "paid",
          currency: "bdt",
        };

        const amountPaisa = {
          $ifNull: [
            "$totalPaisa",
            {
              $round: [
                {
                  $multiply: ["$totalPrice", 100],
                },
                0,
              ],
            },
          ],
        };

        // ==================================
        // Last Six Months
        // ==================================

        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Dhaka",
          year: "numeric",
          month: "2-digit",
        }).formatToParts(new Date());

        const values = Object.fromEntries(
          parts.map(({ type, value }) => [type, value]),
        );

        const months = Array.from(
          { length: 6 },

          (_, i) =>
            new Date(
              Date.UTC(Number(values.year), Number(values.month) - 6 + i, 1),
            )
              .toISOString()
              .slice(0, 7),
        );

        // ==================================
        // Analytics Queries
        // ==================================

        const [
          totalBookings,
          paidBookings,
          confirmedRentals,
          completedRentals,
          totals,
          monthlyBookings,
          monthlyPaid,
          topEquipment,
          categoryResults,
        ] = await Promise.all([
          collection.countDocuments({}),

          collection.countDocuments(paidFilter),

          collection.countDocuments({
            ...paidFilter,
            status: "confirmed",
          }),

          collection.countDocuments({
            ...paidFilter,
            status: "completed",
          }),

          // Total Paid Revenue

          collection
            .aggregate([
              {
                $match: paidFilter,
              },
              {
                $group: {
                  _id: null,

                  totalPaisa: {
                    $sum: amountPaisa,
                  },
                },
              },
            ])
            .toArray(),

          // Monthly Booking Activity

          collection
            .aggregate([
              {
                $match: {
                  createdAt: {
                    $type: "date",
                  },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m",

                      date: "$createdAt",

                      timezone: "Asia/Dhaka",
                    },
                  },

                  bookings: {
                    $sum: 1,
                  },
                },
              },
              {
                $match: {
                  _id: {
                    $in: months,
                  },
                },
              },
            ])
            .toArray(),

          // Monthly Paid Bookings

          collection
            .aggregate([
              {
                $match: paidFilter,
              },
              {
                $project: {
                  month: {
                    $dateToString: {
                      format: "%Y-%m",

                      date: {
                        $ifNull: ["$paidAt", "$createdAt"],
                      },

                      timezone: "Asia/Dhaka",
                    },
                  },

                  amount: amountPaisa,
                },
              },
              {
                $group: {
                  _id: "$month",

                  paidBookings: {
                    $sum: 1,
                  },

                  grossPaisa: {
                    $sum: "$amount",
                  },
                },
              },
              {
                $match: {
                  _id: {
                    $in: months,
                  },
                },
              },
            ])
            .toArray(),

          // Top Five Rented Equipment

          collection
            .aggregate([
              {
                $match: paidFilter,
              },
              {
                $group: {
                  _id: "$equipmentId",

                  name: {
                    $first: "$equipmentName",
                  },

                  paidBookings: {
                    $sum: 1,
                  },

                  unitsRented: {
                    $sum: "$quantity",
                  },

                  grossPaisa: {
                    $sum: amountPaisa,
                  },
                },
              },
              {
                $sort: {
                  paidBookings: -1,
                  unitsRented: -1,
                },
              },
              {
                $limit: 5,
              },
            ])
            .toArray(),

          // Equipment Categories

          collection
            .aggregate([
              {
                $match: paidFilter,
              },
              {
                $lookup: {
                  from: "equipment",

                  localField: "equipmentId",

                  foreignField: "_id",

                  as: "equipment",
                },
              },
              {
                $unwind: {
                  path: "$equipment",

                  preserveNullAndEmptyArrays: true,
                },
              },
              {
                $project: {
                  categories: {
                    $cond: [
                      {
                        $gt: [
                          {
                            $size: {
                              $ifNull: ["$equipment.categories", []],
                            },
                          },
                          0,
                        ],
                      },

                      "$equipment.categories",

                      ["Uncategorized"],
                    ],
                  },

                  unitsRented: "$quantity",
                },
              },
              {
                $unwind: "$categories",
              },
              {
                $group: {
                  _id: "$categories",

                  paidBookings: {
                    $sum: 1,
                  },

                  unitsRented: {
                    $sum: "$unitsRented",
                  },
                },
              },
              {
                $sort: {
                  paidBookings: -1,
                  _id: 1,
                },
              },
              {
                $limit: 8,
              },
            ])
            .toArray(),
        ]);

        // ==================================
        // Build Monthly Results
        // ==================================

        const bookingMap = new Map(monthlyBookings.map((x) => [x._id, x]));

        const paymentMap = new Map(monthlyPaid.map((x) => [x._id, x]));

        // ==================================
        // JSON Response
        // ==================================

        return res.json({
          success: true,

          stats: {
            totalBookings,
            paidBookings,
            confirmedRentals,
            completedRentals,

            grossPaidAmount: (totals[0]?.totalPaisa ?? 0) / 100,
          },

          monthly: months.map((month) => ({
            month,

            bookings: bookingMap.get(month)?.bookings ?? 0,

            paidBookings: paymentMap.get(month)?.paidBookings ?? 0,

            grossPaidAmount: (paymentMap.get(month)?.grossPaisa ?? 0) / 100,
          })),

          topEquipment: topEquipment.map((x) => ({
            equipmentId: x._id?.toString() ?? "",

            name: x.name ?? "Unknown equipment",

            paidBookings: x.paidBookings,

            unitsRented: x.unitsRented,

            grossPaidAmount: (x.grossPaisa ?? 0) / 100,
          })),

          categories: categoryResults.map((x) => ({
            name: x._id,

            paidBookings: x.paidBookings,

            unitsRented: x.unitsRented,
          })),
        });
      } catch (error) {
        console.error("Admin booking analytics:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to load analytics.",
        });
      }
    },
  );
}
