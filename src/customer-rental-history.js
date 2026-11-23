
import { ObjectId } from "mongodb";

const HISTORY_STATUSES = new Set([
  "all",
  "completed",
  "awaiting",
]);

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

function escapeRegex(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function formatTimestamp(value) {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

// =====================================
// Register Customer Rental History
// =====================================

export function registerCustomerRentalHistoryRoutes(
  app,
  { getDb, verifyJWT, requireRole }
) {
  // ===================================
  // GET /bookings/history
  // Customer Only
  // ===================================

  app.get(
    "/bookings/history",
    verifyJWT,
    requireRole("customer"),
    async (req, res) => {
      try {
        const collection = getDb().collection(
          "bookings"
        );

        const today = todayInBangladesh();

        const requestedStatus =
          typeof req.query.status === "string"
            ? req.query.status
            : "all";

        const status = HISTORY_STATUSES.has(
          requestedStatus
        )
          ? requestedStatus
          : "all";

        const search =
          typeof req.query.q === "string"
            ? req.query.q.trim().slice(0, 100)
            : "";

        const sort =
          req.query.sort === "oldest"
            ? "oldest"
            : "newest";

        const requestedPage = Number(
          req.query.page || 1
        );

        const page =
          Number.isSafeInteger(requestedPage) &&
          requestedPage >= 1
            ? Math.min(requestedPage, 10000)
            : 1;

        const limit = 10;

        // =================================
        // Historical paid rentals
        // =================================

        const historyFilter = {
          customerId: req.authUser.id,
          paymentStatus: "paid",

          $or: [
            {
              status: "completed",
            },
            {
              status: "confirmed",
              endDate: {
                $lt: today,
              },
            },
          ],
        };

        const filter = {
          ...historyFilter,
        };

        if (status === "completed") {
          filter.status = "completed";
        }

        if (status === "awaiting") {
          filter.status = "confirmed";
        }

        // =================================
        // Search Equipment or Booking ID
        // =================================

        if (search) {
          const matches = [
            {
              equipmentName: {
                $regex: escapeRegex(search),
                $options: "i",
              },
            },
          ];

          if (/^[a-f0-9]{24}$/i.test(search)) {
            matches.push({
              _id: new ObjectId(search),
            });
          }

          filter.$and = [
            {
              $or: matches,
            },
          ];
        }

        // =================================
        // Fetch records and statistics
        // =================================

        const [
          total,
          bookings,
          completedCount,
          awaitingCount,
          paidTotals,
        ] = await Promise.all([
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
                totalPaisa: 1,
                totalPrice: 1,
                currency: 1,

                division: 1,
                district: 1,
                address: 1,
                notes: 1,

                status: 1,
                paymentStatus: 1,

                paidAt: 1,
                completedAt: 1,
                createdAt: 1,
              },
            })
            .sort({
              endDate:
                sort === "newest" ? -1 : 1,
              _id: -1,
            })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),

          collection.countDocuments({
            ...historyFilter,
            status: "completed",
          }),

          collection.countDocuments({
            ...historyFilter,
            status: "confirmed",
          }),

          // Calculate paid historical
          // rental amounts using paisa.
          // Support older totalPrice records.
          collection
            .aggregate([
              {
                $match: historyFilter,
              },
              {
                $group: {
                  _id: null,

                  totalPaisa: {
                    $sum: {
                      $ifNull: [
                        "$totalPaisa",
                        {
                          $round: [
                            {
                              $multiply: [
                                {
                                  $ifNull: [
                                    "$totalPrice",
                                    0,
                                  ],
                                },
                                100,
                              ],
                            },
                            0,
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            ])
            .toArray(),
        ]);

        // =================================
        // JSON Response
        // =================================

        res.set(
          "Cache-Control",
          "no-store"
        );

        return res.status(200).json({
          success: true,

          bookings: bookings.map((booking) => ({
            _id: booking._id.toString(),

            equipmentId:
              booking.equipmentId?.toString() ||
              "",

            equipmentName:
              booking.equipmentName ||
              "Equipment",

            imageUrl:
              booking.imageUrl || "",

            startDate:
              booking.startDate || "",

            endDate:
              booking.endDate || "",

            totalDays:
              Number(booking.totalDays) || 0,

            quantity:
              Number(booking.quantity) || 0,

            dailyPrice:
              Number(booking.dailyPrice) || 0,

            totalPrice:
              Number(booking.totalPrice) || 0,

            currency:
              booking.currency || "bdt",

            division:
              booking.division || "",

            district:
              booking.district || "",

            address:
              booking.address || "",

            notes:
              booking.notes || "",

            status: booking.status,

            paymentStatus:
              booking.paymentStatus,

            paidAt: formatTimestamp(
              booking.paidAt
            ),

            completedAt: formatTimestamp(
              booking.completedAt
            ),

            createdAt: formatTimestamp(
              booking.createdAt
            ),
          })),

          stats: {
            totalPastRentals:
              completedCount + awaitingCount,

            completedRentals:
              completedCount,

            awaitingCompletion:
              awaitingCount,

            totalPaidAmount:
              (paidTotals[0]?.totalPaisa || 0) /
              100,
          },

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(
              total / limit
            ),
          },
        });
      } catch (error) {
        console.error(
          "Customer rental history error:",
          error
        );

        return res.status(500).json({
          success: false,
          error:
            "Unable to load rental history.",
        });
      }
    }
  );
}
