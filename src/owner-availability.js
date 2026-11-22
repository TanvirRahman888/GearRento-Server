
import { ObjectId } from "mongodb";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 60;
const MAX_FUTURE_DAYS = 365;

class AvailabilityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// =====================================
// Helpers
// =====================================

function todayInBangladesh() {
  const parts = new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ])
  );

  return (
    `${values.year}-${values.month}-${values.day}`
  );
}

function parseDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  const date = new Date(
    `${value}T00:00:00.000Z`
  );

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }

  return date;
}

function validateDateRange(
  startDate,
  endDate
) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const today = parseDate(
    todayInBangladesh()
  );

  if (!start || !end || end < start) {
    throw new AvailabilityError(
      400,
      "Select a valid date range."
    );
  }

  const days =
    Math.round(
      (end.getTime() - start.getTime()) /
        DAY_MS
    ) + 1;

  if (
    days < 1 ||
    days > MAX_RANGE_DAYS
  ) {
    throw new AvailabilityError(
      400,
      "You can update a maximum of 60 days at once."
    );
  }

  const maximumDate = new Date(
    today.getTime() +
      MAX_FUTURE_DAYS * DAY_MS
  );

  if (
    start < today ||
    end > maximumDate
  ) {
    throw new AvailabilityError(
      400,
      "Dates must be between today and the next 365 days."
    );
  }

  const dates = [];

  for (
    let timestamp = start.getTime();
    timestamp <= end.getTime();
    timestamp += DAY_MS
  ) {
    dates.push(
      new Date(timestamp)
        .toISOString()
        .slice(0, 10)
    );
  }

  return dates;
}

function parseMonth(value) {
  const fallback =
    todayInBangladesh().slice(0, 7);

  const month =
    typeof value === "string"
      ? value
      : fallback;

  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new AvailabilityError(
      400,
      "Invalid calendar month."
    );
  }

  const [year, monthNumber] =
    month.split("-").map(Number);

  if (
    year < 2000 ||
    year > 2100 ||
    monthNumber < 1 ||
    monthNumber > 12
  ) {
    throw new AvailabilityError(
      400,
      "Invalid calendar month."
    );
  }

  const firstDay = new Date(
    Date.UTC(year, monthNumber - 1, 1)
  );

  const lastDay = new Date(
    Date.UTC(year, monthNumber, 0)
  );

  return {
    month,
    startDate:
      firstDay.toISOString().slice(0, 10),
    endDate:
      lastDay.toISOString().slice(0, 10),
  };
}

function sendError(res, error, label) {
  if (error instanceof AvailabilityError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error(label, error);

  return res.status(500).json({
    success: false,
    error: "Unable to process availability.",
  });
}

function equipmentIdFromRequest(req) {
  if (
    !/^[a-f0-9]{24}$/i.test(
      req.params.id || ""
    )
  ) {
    throw new AvailabilityError(
      400,
      "Invalid equipment ID."
    );
  }

  return new ObjectId(req.params.id);
}

// =====================================
// Register Owner Availability Routes
// =====================================

export function registerOwnerAvailabilityRoutes(
  app,
  {
    getDb,
    getMongoClient,
    verifyJWT,
    requireRole,
  }
) {
  const ownerAuth = [
    verifyJWT,
    requireRole("owner"),
  ];

  // ===================================
  // GET /owner/availability/equipment
  // List Owner's Equipment
  // ===================================

  app.get(
    "/owner/availability/equipment",
    ...ownerAuth,
    async (req, res) => {
      try {
        const db = getDb();

        const filter = {
          ownerId: req.authUser.id,
        };

        const collection =
          db.collection("equipment");

        const [total, equipment] =
          await Promise.all([
            collection.countDocuments(filter),

            collection
              .find(filter, {
                projection: {
                  name: 1,
                  status: 1,
                  imageUrls: 1,
                  quantity: 1,
                  availableQuantity: 1,
                },
              })
              .sort({
                createdAt: -1,
                _id: -1,
              })
              .limit(200)
              .toArray(),
          ]);

        res.set("Cache-Control", "no-store");

        return res.json({
          success: true,
          equipment: equipment.map((item) => ({
            id: item._id.toString(),
            name: item.name || "Unnamed Equipment",
            status: item.status || "pending",
            imageUrl:
              item.imageUrls?.[0] || "",
            quantity:
              Number(item.quantity) || 0,
            availableQuantity:
              Number(item.availableQuantity) || 0,
          })),
          total,
          hasMore: total > 200,
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Owner availability equipment error:"
        );
      }
    }
  );

  // ===================================
  // GET /owner/availability/:id
  // View Monthly Calendar
  // ===================================

  app.get(
    "/owner/availability/:id",
    ...ownerAuth,
    async (req, res) => {
      try {
        const id = equipmentIdFromRequest(req);
        const period = parseMonth(
          req.query.month
        );

        const db = getDb();

        const equipment =
          await db.collection("equipment").findOne(
            {
              _id: id,
              ownerId: req.authUser.id,
            },
            {
              projection: {
                name: 1,
                status: 1,
                quantity: 1,
                availableQuantity: 1,
                blockedDates: 1,
              },
            }
          );

        if (!equipment) {
          throw new AvailabilityError(
            404,
            "Equipment not found."
          );
        }

        const reservations = await db
          .collection("bookings")
          .find(
            {
              equipmentId: id,

              startDate: {
                $lte: period.endDate,
              },

              endDate: {
                $gte: period.startDate,
              },

              status: {
                $in: [
                  "checkout_pending",
                  "confirmed",
                  "completed",
                ],
              },
            },
            {
              projection: {
                startDate: 1,
                endDate: 1,
                quantity: 1,
                status: 1,
                paymentStatus: 1,
              },
            }
          )
          .toArray();

        const blockedDates = Array.isArray(
          equipment.blockedDates
        )
          ? equipment.blockedDates.filter(
              (date) =>
                typeof date === "string" &&
                date >= period.startDate &&
                date <= period.endDate
            )
          : [];

        res.set("Cache-Control", "no-store");

        return res.json({
          success: true,
          month: period.month,

          equipment: {
            id: equipment._id.toString(),
            name: equipment.name,
            status: equipment.status,
            quantity:
              Number(equipment.quantity) || 0,
            availableQuantity:
              Number(equipment.availableQuantity) || 0,
          },

          blockedDates,

          reservations: reservations.map(
            (booking) => ({
              id: booking._id.toString(),
              startDate: booking.startDate,
              endDate: booking.endDate,
              quantity:
                Number(booking.quantity) || 0,
              status: booking.status,
              paymentStatus:
                booking.paymentStatus,
            })
          ),
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Owner availability calendar error:"
        );
      }
    }
  );

  // ===================================
  // PATCH /owner/availability/:id
  // Block or Reopen Date Range
  // ===================================

  app.patch(
    "/owner/availability/:id",
    ...ownerAuth,
    async (req, res) => {
      let session;

      try {
        const id = equipmentIdFromRequest(req);

        const {
          action,
          startDate,
          endDate,
        } = req.body || {};

        if (
          action !== "block" &&
          action !== "unblock"
        ) {
          throw new AvailabilityError(
            400,
            "Action must be block or unblock."
          );
        }

        const dates = validateDateRange(
          startDate,
          endDate
        );

        const db = getDb();

        const equipmentCollection =
          db.collection("equipment");

        const filter = {
          _id: id,
          ownerId: req.authUser.id,
        };

        session =
          getMongoClient().startSession();

        await session.withTransaction(
          async () => {
            // Write to the equipment document
            // first, just like booking creation.
            // This coordinates competing booking
            // and availability transactions.
            const locked =
              await equipmentCollection.updateOne(
                filter,
                {
                  $inc: {
                    bookingLockVersion: 1,
                  },
                },
                { session }
              );

            if (locked.matchedCount !== 1) {
              throw new AvailabilityError(
                404,
                "Equipment not found."
              );
            }

            if (action === "block") {
              // Owners must not block dates
              // already reserved by Customers.
              const existingBooking = await db
                .collection("bookings")
                .findOne(
                  {
                    equipmentId: id,

                    startDate: {
                      $lte: endDate,
                    },

                    endDate: {
                      $gte: startDate,
                    },

                    status: {
                      $in: [
                        "checkout_pending",
                        "confirmed",
                      ],
                    },
                  },
                  {
                    session,
                    projection: { _id: 1 },
                  }
                );

              if (existingBooking) {
                throw new AvailabilityError(
                  409,
                  "One or more dates have existing reservations. Choose dates without bookings."
                );
              }
            }

            const now = new Date();

            const update =
              action === "block"
                ? {
                    $addToSet: {
                      blockedDates: {
                        $each: dates,
                      },
                    },
                    $set: {
                      updatedAt: now,
                    },
                  }
                : {
                    $pull: {
                      blockedDates: {
                        $in: dates,
                      },
                    },
                    $set: {
                      updatedAt: now,
                    },
                  };

            await equipmentCollection.updateOne(
              filter,
              update,
              { session }
            );
          },
          {
            readConcern: {
              level: "snapshot",
            },
            writeConcern: {
              w: "majority",
            },
          }
        );

        return res.json({
          success: true,
          message:
            action === "block"
              ? `${dates.length} date(s) blocked successfully.`
              : `${dates.length} date(s) reopened successfully.`,
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Update Owner availability error:"
        );
      } finally {
        if (session) {
          await session.endSession();
        }
      }
    }
  );
}
