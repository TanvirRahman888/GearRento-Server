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

 
  // =====================================
  // GET /bookings/mine
  // Customer: My Bookings
  // =====================================

  app.get(
    "/bookings/mine",
    verifyJWT,
    requireRole("customer"),
    async (req, res) => {
      try {
        const requestedPage = Number(req.query.page || 1);

        const page =
          Number.isSafeInteger(requestedPage) &&
          requestedPage > 0
            ? Math.min(requestedPage, 100000)
            : 1;

        const limit = 10;

        // Only show bookings belonging to
        // the authenticated Customer
        const filter = {
          customerId: req.authUser.id,
        };

        const collection = getDb().collection("bookings");

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
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        ]);

        return res.status(200).json({
          success: true,

          bookings: bookings.map((booking) => ({
            ...booking,
            _id: booking._id.toString(),
            equipmentId: booking.equipmentId.toString(),
          })),

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        console.error("My Bookings API error:", error);

        return res.status(500).json({
          success: false,
          error: "Unable to load your bookings.",
        });
      }
    }
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


// ==========================================
// GET /bookings/owner
// Owner: View paid rental bookings
// ==========================================

app.get(
  "/bookings/owner",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    try {
      const requestedPage = Number(req.query.page || 1);

      const page =
        Number.isSafeInteger(requestedPage) &&
        requestedPage >= 1
          ? Math.min(requestedPage, 100000)
          : 1;

      const requestedStatus =
        typeof req.query.status === "string"
          ? req.query.status
          : "all";

      const status = [
        "all",
        "confirmed",
        "completed",
      ].includes(requestedStatus)
        ? requestedStatus
        : "all";

      const limit = 10;

      // IMPORTANT: Owner ID comes from JWT,
      // never from request query parameters.
      const baseFilter = {
        ownerId: req.authUser.id,
        paymentStatus: "paid",
      };

      const filter = {
        ...baseFilter,
        status:
          status === "all"
            ? { $in: ["confirmed", "completed"] }
            : status,
      };

      const collection = getDb().collection("bookings");

      const [
        total,
        confirmedCount,
        completedCount,
        bookings,
      ] = await Promise.all([
        collection.countDocuments(filter),

        collection.countDocuments({
          ...baseFilter,
          status: "confirmed",
        }),

        collection.countDocuments({
          ...baseFilter,
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
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);

      return res.status(200).json({
        success: true,

        bookings: bookings.map((booking) => ({
          ...booking,
          _id: booking._id.toString(),
          equipmentId: booking.equipmentId.toString(),
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
      console.error("Owner rentals error:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load rental bookings.",
      });
    }
  }
);

// ==========================================
// PATCH /bookings/owner/:id/complete
// Owner: Mark a returned rental completed
// ==========================================

app.patch(
  "/bookings/owner/:id/complete",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!/^[a-f0-9]{24}$/i.test(id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid booking ID.",
        });
      }

      const today = todayInBangladesh();

      // Atomic conditional update:
      // - correct Owner
      // - confirmed and paid booking
      // - rental period already ended
      const result = await getDb()
        .collection("bookings")
        .updateOne(
          {
            _id: new ObjectId(id),
            ownerId: req.authUser.id,
            status: "confirmed",
            paymentStatus: "paid",
            endDate: { $lt: today },
          },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );

      if (result.matchedCount === 0) {
        return res.status(409).json({
          success: false,
          error:
            "Booking not eligible for completion. Check ownership, payment status, and rental end date.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Rental marked as completed.",
      });
    } catch (error) {
      console.error("Complete rental error:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to complete rental.",
      });
    }
  }
);

// ==========================================
// GET /bookings/admin
// Admin: View all rental bookings
// ==========================================

app.get(
  "/bookings/admin",
  verifyJWT,
  requireRole("admin"),
  async (req, res) => {
    try {
      const getQuery = (key) =>
        typeof req.query[key] === "string"
          ? req.query[key].trim()
          : "";

      const requestedPage = Number(
        getQuery("page") || 1
      );

      const page =
        Number.isSafeInteger(requestedPage) &&
        requestedPage > 0
          ? Math.min(requestedPage, 100000)
          : 1;

      const limit = 10;

      // ==================================
      // Filters
      // ==================================

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

      const allowedPayments = [
        "all",
        "paid",
        "unpaid",
      ];

      const requestedStatus = getQuery("status");
      const requestedPayment = getQuery("payment");

      const status = allowedStatuses.includes(
        requestedStatus
      )
        ? requestedStatus
        : "all";

      const payment = allowedPayments.includes(
        requestedPayment
      )
        ? requestedPayment
        : "all";

      const search = getQuery("q").slice(0, 100);

      const filter = {};

      if (status !== "all") {
        filter.status = status;
      }

      if (payment !== "all") {
        filter.paymentStatus = payment;
      }

      // ==================================
      // Search equipment, customer, phone
      // or an exact MongoDB booking ID.
      // ==================================

      if (search) {
        const escapedSearch = search.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

        const matches = [
          {
            equipmentName: {
              $regex: escapedSearch,
              $options: "i",
            },
          },
          {
            fullName: {
              $regex: escapedSearch,
              $options: "i",
            },
          },
          {
            phone: {
              $regex: escapedSearch,
              $options: "i",
            },
          },
        ];

        if (/^[a-f0-9]{24}$/i.test(search)) {
          matches.push({
            _id: new ObjectId(search),
          });
        }

        filter.$or = matches;
      }

      const collection = getDb().collection("bookings");

      // ==================================
      // Query records and global statistics
      // ==================================

      const [
        total,
        bookings,
        totalBookings,
        paidBookings,
        confirmedBookings,
        completedBookings,
        grossPaidResult,
      ] = await Promise.all([
        // Total matching current filters
        collection.countDocuments(filter),

        // Paginated booking records
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
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),

        // Global statistics, not filtered
        collection.countDocuments({}),

        collection.countDocuments({
          paymentStatus: "paid",
        }),

        collection.countDocuments({
          status: "confirmed",
          paymentStatus: "paid",
        }),

        collection.countDocuments({
          status: "completed",
          paymentStatus: "paid",
        }),

        // Sum paid amounts using integer paisa
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

      return res.status(200).json({
        success: true,

        bookings: bookings.map((booking) => ({
          ...booking,

          _id: booking._id.toString(),

          equipmentId:
            booking.equipmentId?.toString() || "",

          ownerId:
            booking.ownerId?.toString() || "",

          customerId:
            booking.customerId?.toString() || "",
        })),

        stats: {
          totalBookings,
          paidBookings,
          confirmedBookings,
          completedBookings,

          grossPaidAmount:
            (grossPaidResult[0]?.totalPaisa || 0) /
            100,
        },

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error(
        "Admin All Rentals API error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load rental bookings.",
      });
    }
  }
);


// ==========================================
// Helper: Last 6 months in Bangladesh
// ==========================================

function getLastSixMonths() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  const year = Number(values.year);
  const month = Number(values.month);

  const months = [];

  for (let i = 5; i >= 0; i--) {
    const date = new Date(
      Date.UTC(year, month - 1 - i, 1)
    );

    months.push(date.toISOString().slice(0, 7));
  }

  return months;
}

// ==========================================
// GET /bookings/admin/analytics
// Admin: Analytics Dashboard
// ==========================================

app.get(
  "/bookings/admin/analytics",
  verifyJWT,
  requireRole("admin"),
  async (req, res) => {
    try {
      const collection = getDb().collection("bookings");

      const months = getLastSixMonths();

      const paidFilter = {
        paymentStatus: "paid",
        currency: "bdt",
      };

      // Integer paisa avoids floating-point
      // accumulation of currency values.
      // Older records can fall back to totalPrice.
      const amountInPaisa = {
        $ifNull: [
          "$totalPaisa",
          {
            $round: [
              { $multiply: ["$totalPrice", 100] },
              0,
            ],
          },
        ],
      };

      const [
        totalBookings,
        paidBookings,
        confirmedRentals,
        completedRentals,
        totalRevenueResult,
        monthlyBookingResult,
        monthlyPaymentResult,
        topEquipmentResult,
        categoryResult,
      ] = await Promise.all([
        // All booking records
        collection.countDocuments({}),

        // Successfully paid bookings
        collection.countDocuments(paidFilter),

        // Confirmed rentals
        collection.countDocuments({
          ...paidFilter,
          status: "confirmed",
        }),

        // Completed rentals
        collection.countDocuments({
          ...paidFilter,
          status: "completed",
        }),

        // ==================================
        // Gross Paid Amount
        // ==================================

        collection
          .aggregate([
            { $match: paidFilter },

            {
              $group: {
                _id: null,
                totalPaisa: {
                  $sum: amountInPaisa,
                },
              },
            },
          ])
          .toArray(),

        // ==================================
        // Monthly Booking Activity
        // Includes all Checkout attempts
        // ==================================

        collection
          .aggregate([
            {
              $match: {
                createdAt: { $type: "date" },
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
                bookings: { $sum: 1 },
              },
            },

            {
              $match: {
                _id: { $in: months },
              },
            },
          ])
          .toArray(),

        // ==================================
        // Monthly Paid Bookings and Revenue
        // Uses paidAt, falling back to createdAt
        // ==================================

        collection
          .aggregate([
            { $match: paidFilter },

            {
              $project: {
                month: {
                  $dateToString: {
                    format: "%Y-%m",
                    date: {
                      $ifNull: [
                        "$paidAt",
                        "$createdAt",
                      ],
                    },
                    timezone: "Asia/Dhaka",
                  },
                },
                amount: amountInPaisa,
              },
            },

            {
              $group: {
                _id: "$month",
                paidBookings: { $sum: 1 },
                grossPaisa: { $sum: "$amount" },
              },
            },

            {
              $match: {
                _id: { $in: months },
              },
            },
          ])
          .toArray(),

        // ==================================
        // Top 5 Rented Equipment
        // Paid bookings only
        // ==================================

        collection
          .aggregate([
            { $match: paidFilter },

            {
              $group: {
                _id: "$equipmentId",
                name: { $first: "$equipmentName" },
                paidBookings: { $sum: 1 },
                unitsRented: { $sum: "$quantity" },
                grossPaisa: { $sum: amountInPaisa },
              },
            },

            {
              $sort: {
                paidBookings: -1,
                unitsRented: -1,
              },
            },

            { $limit: 5 },
          ])
          .toArray(),

        // ==================================
        // Equipment Category Performance
        // Join bookings with equipment
        // ==================================

        collection
          .aggregate([
            { $match: paidFilter },

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
                            $ifNull: [
                              "$equipment.categories",
                              [],
                            ],
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

            { $unwind: "$categories" },

            {
              $group: {
                _id: "$categories",
                paidBookings: { $sum: 1 },
                unitsRented: { $sum: "$unitsRented" },
              },
            },

            {
              $sort: {
                paidBookings: -1,
                _id: 1,
              },
            },

            { $limit: 8 },
          ])
          .toArray(),
      ]);

      // ==================================
      // Fill missing months with zero values
      // ==================================

      const bookingMap = new Map(
        monthlyBookingResult.map((item) => [
          item._id,
          item,
        ])
      );

      const paymentMap = new Map(
        monthlyPaymentResult.map((item) => [
          item._id,
          item,
        ])
      );

      const monthly = months.map((month) => {
        const booking = bookingMap.get(month);
        const payment = paymentMap.get(month);

        return {
          month,
          bookings: booking?.bookings || 0,
          paidBookings: payment?.paidBookings || 0,
          grossPaidAmount:
            (payment?.grossPaisa || 0) / 100,
        };
      });

      // ==================================
      // Response
      // ==================================

      return res.status(200).json({
        success: true,

        stats: {
          totalBookings,
          paidBookings,
          confirmedRentals,
          completedRentals,

          grossPaidAmount:
            (totalRevenueResult[0]?.totalPaisa || 0) /
            100,
        },

        monthly,

        topEquipment: topEquipmentResult.map(
          (item) => ({
            equipmentId: item._id?.toString() || "",
            name: item.name || "Unknown equipment",
            paidBookings: item.paidBookings,
            unitsRented: item.unitsRented,
            grossPaidAmount:
              (item.grossPaisa || 0) / 100,
          })
        ),

        categories: categoryResult.map((item) => ({
          name: item._id,
          paidBookings: item.paidBookings,
          unitsRented: item.unitsRented,
        })),
      });
    } catch (error) {
      console.error(
        "Admin analytics error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load analytics.",
      });
    }
  }
);


}
