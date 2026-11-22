import express from "express";
import Stripe from "stripe";
import { ObjectId } from "mongodb";

// =====================================
// Configuration
// =====================================

const DAY_MS = 24 * 60 * 60 * 1000;

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

let stripeInstance;

function getStripe() {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("Missing STRIPE_SECRET_KEY");
    }
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

    if (!secretKey?.startsWith("sk_test_")) {
      throw new Error(
        "STRIPE_SECRET_KEY must be a Stripe test secret key (sk_test_...).",
      );
    }

    stripeInstance = new Stripe(secretKey);

    // stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeInstance;
}

function cleanText(value, max = 200) {
  if (typeof value !== "string") return "";

  return value.trim().slice(0, max + 1);
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  return date;
}

function todayInBangladesh() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

class BookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// =====================================
// Stripe Webhook
// Register BEFORE express.json()
// =====================================

export function registerStripeWebhook(app, getDb) {
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      let event;

      try {
        event = getStripe().webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"],
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch (error) {
        console.error("Stripe webhook verification failed:", error.message);

        return res.status(400).send("Invalid webhook signature");
      }

      const allowedEvents = [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
      ];

      if (!allowedEvents.includes(event.type)) {
        return res.json({ received: true });
      }

      const checkout = event.data.object;
      const bookingId = checkout.metadata?.bookingId;

      // Ignore unrelated Stripe test events.
      if (
        !bookingId ||
        !/^[a-f0-9]{24}$/i.test(bookingId) ||
        checkout.client_reference_id !== bookingId
      ) {
        return res.json({ received: true });
      }

      try {
        const bookings = getDb().collection("bookings");

        const id = new ObjectId(bookingId);

        const booking = await bookings.findOne({
          _id: id,
        });

        if (!booking) {
          // Unrelated session in the Stripe account
          return res.json({ received: true });
        }

        // Match the correct Stripe session.
        // The session ID can still be null if Stripe
        // delivers its webhook before our DB update.
        if (
          booking.stripeSessionId &&
          booking.stripeSessionId !== checkout.id
        ) {
          return res.status(409).send("Checkout session mismatch");
        }

        // Verify amount and currency for successful payments.
        const paidEvent =
          event.type === "checkout.session.completed" ||
          event.type === "checkout.session.async_payment_succeeded";

        if (paidEvent) {
          if (checkout.payment_status !== "paid") {
            return res.json({ received: true });
          }

          if (
            checkout.currency !== "bdt" ||
            checkout.amount_total !== booking.totalPaisa
          ) {
            console.error("Stripe payment mismatch:", checkout.id);

            return res.status(500).send("Payment requires investigation");
          }

          await bookings.updateOne(
            {
              _id: id,
              status: "checkout_pending",
              $or: [
                { stripeSessionId: checkout.id },
                { stripeSessionId: null },
              ],
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
                paidAt: new Date(),
                updatedAt: new Date(),
              },
            },
          );
        }

        // Handle abandoned or failed Checkout.
        if (
          event.type === "checkout.session.expired" ||
          event.type === "checkout.session.async_payment_failed"
        ) {
          await bookings.updateOne(
            {
              _id: id,
              status: "checkout_pending",
              $or: [
                { stripeSessionId: checkout.id },
                { stripeSessionId: null },
              ],
            },
            {
              $set: {
                stripeSessionId: checkout.id,
                status:
                  event.type === "checkout.session.expired"
                    ? "expired"
                    : "payment_failed",
                updatedAt: new Date(),
              },
            },
          );
        }

        return res.json({ received: true });
      } catch (error) {
        console.error("Stripe webhook database error:", error);

        return res.status(500).send("Webhook processing failed");
      }
    },
  );
}

// =====================================
// Customer Booking Routes
// =====================================

export function registerBookingRoutes(
  app,
  { getDb, getMongoClient, verifyJWT, requireRole },
) {
  // ===================================
  // POST /bookings/checkout
  // ===================================

  app.post(
    "/bookings/checkout",
    verifyJWT,
    requireRole("customer"),
    async (req, res) => {
      const db = getDb();
      const equipmentCollection = db.collection("equipment");
      const bookings = db.collection("bookings");

      const { equipmentId, startDate, endDate, quantity } = req.body || {};

      const fullName = cleanText(req.body?.fullName, 100);
      const phone = cleanText(req.body?.phone, 30);
      const address = cleanText(req.body?.address, 500);
      const district = cleanText(req.body?.district, 100);
      const division = cleanText(req.body?.division, 40);
      const notes = cleanText(req.body?.notes, 500);

      // ===============================
      // Validate booking information
      // ===============================

      if (
        typeof equipmentId !== "string" ||
        !/^[a-f0-9]{24}$/i.test(equipmentId)
      ) {
        return res.status(400).json({
          error: "Invalid equipment ID.",
        });
      }

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

      if (totalDays < 1 || totalDays > 30) {
        return res.status(400).json({
          error: "Rental duration must be 1 to 30 days.",
        });
      }

      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
        return res.status(400).json({
          error: "Invalid rental quantity.",
        });
      }

      if (
        fullName.length < 2 ||
        fullName.length > 100 ||
        address.length < 10 ||
        address.length > 500
      ) {
        return res.status(400).json({
          error: "Enter your name and complete address.",
        });
      }

      if (!/^\+?[0-9][0-9\s-]{8,18}$/.test(phone)) {
        return res.status(400).json({
          error: "Enter a valid contact number.",
        });
      }

      if (
        district.length < 2 ||
        district.length > 100 ||
        !divisions.includes(division) ||
        notes.length > 500
      ) {
        return res.status(400).json({
          error: "Enter valid delivery information.",
        });
      }

      // ===============================
      // Reserve equipment in MongoDB
      // ===============================

      let bookingId;
      let equipment;

      const mongoSession = getMongoClient().startSession();

      try {
        bookingId = await mongoSession.withTransaction(
          async () => {
            const id = new ObjectId(equipmentId);

            // A write on the equipment document
            // serializes competing booking transactions.
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
              { session: mongoSession },
            );

            // Validate selected rental division
            if (!equipment.divisions?.includes(division)) {
              throw new BookingError(
                "Equipment is not available in that division.",
                409,
              );
            }

            // Continue with price calculation
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

            // Find reservations overlapping
            // the requested date range.
            const activeBookings = await bookings
              .find(
                {
                  equipmentId: id,
                  startDate: { $lte: endDate },
                  endDate: { $gte: startDate },
                  status: {
                    $in: ["checkout_pending", "confirmed"],
                  },
                },
                { session: mongoSession },
              )
              .project({
                startDate: 1,
                endDate: 1,
                quantity: 1,
              })
              .toArray();

            // Check inventory separately for each day.
            // This avoids counting nonconcurrent
            // bookings as though they overlap.
            for (
              let timestamp = start.getTime();
              timestamp <= end.getTime();
              timestamp += DAY_MS
            ) {
              const day = new Date(timestamp).toISOString().slice(0, 10);

              const occupied = activeBookings.reduce((sum, booked) => {
                if (booked.startDate <= day && booked.endDate >= day) {
                  return sum + booked.quantity;
                }

                return sum;
              }, 0);

              if (occupied + quantity > equipment.availableQuantity) {
                throw new BookingError(
                  `Not enough units available on ${day}.`,
                  409,
                );
              }
            }

            const now = new Date();

            const result = await bookings.insertOne(
              {
                equipmentId: id,
                ownerId: equipment.ownerId,
                customerId: req.authUser.id,

                equipmentName: equipment.name,
                imageUrl: equipment.imageUrls?.[0] || "",

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
                division,
                district,
                address,
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
        if (error instanceof BookingError) {
          return res.status(error.status).json({
            error: error.message,
          });
        }

        console.error("Booking reservation error:", error);

        return res.status(500).json({
          error: "Unable to reserve equipment.",
        });
      } finally {
        await mongoSession.endSession();
      }

      // ===============================
      // Create Stripe Checkout Session
      // ===============================

      let checkout;

      try {
        const booking = await bookings.findOne({
          _id: new ObjectId(bookingId),
        });

        const clientURL = process.env.CLIENT_URL?.replace(/\/+$/, "");

        if (!clientURL) {
          throw new Error("Missing CLIENT_URL");
        }

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
                quantity: booking.totalDays * booking.quantity,
              },
            ],

            success_url:
              `${clientURL}/booking/success` +
              "?session_id={CHECKOUT_SESSION_ID}",

            cancel_url:
              `${clientURL}/booking/cancel` + `?booking_id=${bookingId}`,

            expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          },
          {
            idempotencyKey: `gearrento-booking-${bookingId}`,
          },
        );

        if (!checkout.url) {
          throw new Error("Stripe Checkout URL missing.");
        }

        const updated = await bookings.updateOne(
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

        if (!updated.modifiedCount) {
          throw new Error("Unable to save Checkout Session.");
        }

        return res.status(201).json({
          success: true,
          bookingId,
          url: checkout.url,
        });
      } catch (error) {
        console.error("Stripe Checkout error:", error);

        if (checkout?.id) {
          try {
            await getStripe().checkout.sessions.expire(checkout.id);
          } catch (expireError) {
            console.error("Stripe session cleanup:", expireError);
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

  // ===================================
  // GET /bookings/mine
  // ===================================

  app.get(
    "/bookings/mine",
    verifyJWT,
    requireRole("customer"),
    async (req, res) => {
      try {
        const bookings = await getDb()
          .collection("bookings")
          .find(
            {
              customerId: req.authUser.id,
            },
            {
              projection: {
                equipmentName: 1,
                imageUrl: 1,
                startDate: 1,
                endDate: 1,
                quantity: 1,
                totalPrice: 1,
                currency: 1,
                status: 1,
                createdAt: 1,
              },
            },
          )
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();

        return res.json({
          success: true,
          bookings: bookings.map((booking) => ({
            ...booking,
            _id: booking._id.toString(),
          })),
        });
      } catch (error) {
        console.error("My bookings error:", error);

        return res.status(500).json({
          error: "Unable to load bookings.",
        });
      }
    },
  );

  // ===================================
  // GET /bookings/session/:sessionId
  // ===================================

  app.get(
    "/bookings/session/:sessionId",
    verifyJWT,
    requireRole("customer"),
    async (req, res) => {
      try {
        const { sessionId } = req.params;

        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
          return res.status(400).json({
            error: "Invalid Checkout Session ID.",
          });
        }

        const booking = await getDb()
          .collection("bookings")
          .findOne(
            {
              customerId: req.authUser.id,
              stripeSessionId: sessionId,
            },
            {
              projection: {
                status: 1,
                equipmentName: 1,
                totalPrice: 1,
                currency: 1,
              },
            },
          );

        if (!booking) {
          return res.status(404).json({
            error: "Booking not found.",
          });
        }

        return res.json({
          success: true,
          status: booking.status,
          equipmentName: booking.equipmentName,
          totalPrice: booking.totalPrice,
          currency: booking.currency,
        });
      } catch (error) {
        console.error("Booking status error:", error);

        return res.status(500).json({
          error: "Unable to load booking status.",
        });
      }
    },
  );
}
