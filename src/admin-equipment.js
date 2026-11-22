
import { ObjectId } from "mongodb";
import sanitizeHtml from "sanitize-html";

// ======================================
// Constants
// ======================================

const allowedStatuses = [
  "all",
  "pending",
  "approved",
  "rejected",
];

const allowedSorts = [
  "newest",
  "oldest",
  "name-asc",
  "name-desc",
  "price-low",
  "price-high",
];

// ======================================
// Helpers
// ======================================

function getQueryValue(value, max = 100) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function escapeRegex(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function getIdCandidates(id) {
  const ids = [id];

  if (/^[a-f0-9]{24}$/i.test(id)) {
    ids.push(new ObjectId(id));
  }

  return ids;
}

function getSortOptions(sort) {
  switch (sort) {
    case "oldest":
      return {
        createdAt: 1,
        _id: 1,
      };

    case "name-asc":
      return {
        name: 1,
        _id: 1,
      };

    case "name-desc":
      return {
        name: -1,
        _id: -1,
      };

    case "price-low":
      return {
        dailyPrice: 1,
        _id: 1,
      };

    case "price-high":
      return {
        dailyPrice: -1,
        _id: -1,
      };

    default:
      return {
        createdAt: -1,
        _id: -1,
      };
  }
}

function cleanDescription(html) {
  return sanitizeHtml(html || "", {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

// ======================================
// Register Admin Equipment Routes
// ======================================

export function registerAdminEquipmentRoutes(
  app,
  { getDb, verifyJWT, requireRole }
) {
  // ====================================
  // GET /admin/equipment
  // ====================================

  app.get(
    "/admin/equipment",
    verifyJWT,
    requireRole("admin"),
    async (req, res) => {
      try {
        const db = getDb();

        const equipmentCollection =
          db.collection("equipment");

        const search = getQueryValue(req.query.q);

        const requestedStatus = getQueryValue(
          req.query.status
        );

        const requestedCategory = getQueryValue(
          req.query.category
        );

        const requestedDivision = getQueryValue(
          req.query.division
        );

        const requestedSort = getQueryValue(
          req.query.sort
        );

        const status = allowedStatuses.includes(
          requestedStatus
        )
          ? requestedStatus
          : "all";

        const sort = allowedSorts.includes(
          requestedSort
        )
          ? requestedSort
          : "newest";

        const requestedPage = Number(
          req.query.page || 1
        );

        const page =
          Number.isSafeInteger(requestedPage) &&
          requestedPage > 0
            ? Math.min(requestedPage, 10000)
            : 1;

        const limit = 10;

        // ==============================
        // Filters
        // ==============================

        const filter = {};

        if (status !== "all") {
          filter.status = status;
        }

        if (requestedCategory !== "all" &&
            requestedCategory) {
          filter.categories = requestedCategory;
        }

        if (requestedDivision !== "all" &&
            requestedDivision) {
          filter.divisions = requestedDivision;
        }

        if (search) {
          const pattern = escapeRegex(search);

          filter.$or = [
            {
              name: {
                $regex: pattern,
                $options: "i",
              },
            },
            {
              categories: {
                $regex: pattern,
                $options: "i",
              },
            },
          ];
        }

        // ==============================
        // Fetch matching equipment and
        // global status statistics
        // ==============================

        const [
          total,
          equipment,
          allCount,
          approvedCount,
          pendingCount,
          rejectedCount,
        ] = await Promise.all([
          equipmentCollection.countDocuments(filter),

          equipmentCollection
            .find(filter, {
              projection: {
                name: 1,
                categories: 1,
                divisions: 1,
                condition: 1,

                descriptionHtml: 1,

                imageUrls: 1,

                dailyPrice: 1,
                quantity: 1,
                availableQuantity: 1,

                ownerId: 1,
                status: 1,

                reviewReason: 1,
                reviewedAt: 1,

                createdAt: 1,
                updatedAt: 1,
              },
            })
            .sort(getSortOptions(sort))
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),

          equipmentCollection.countDocuments({}),

          equipmentCollection.countDocuments({
            status: "approved",
          }),

          equipmentCollection.countDocuments({
            status: "pending",
          }),

          equipmentCollection.countDocuments({
            status: "rejected",
          }),
        ]);

        // ==============================
        // Resolve Owner information
        // Better Auth uses the "user"
        // collection.
        // ==============================

        const ownerIds = [
          ...new Set(
            equipment
              .map((item) =>
                item.ownerId?.toString()
              )
              .filter(Boolean)
          ),
        ];

        const candidateIds = ownerIds.flatMap(
          getIdCandidates
        );

        const owners = candidateIds.length
          ? await db
              .collection("user")
              .find(
                {
                  _id: {
                    $in: candidateIds,
                  },
                },
                {
                  projection: {
                    name: 1,
                    email: 1,
                  },
                }
              )
              .toArray()
          : [];

        const ownerMap = new Map(
          owners.map((owner) => [
            owner._id.toString(),
            {
              id: owner._id.toString(),
              name: owner.name || "Unnamed Owner",
              email: owner.email || "",
            },
          ])
        );

        const serializedEquipment = equipment.map(
          (item) => {
            const ownerId =
              item.ownerId?.toString() || "";

            return {
              _id: item._id.toString(),

              name: item.name || "Unnamed Equipment",

              categories: Array.isArray(
                item.categories
              )
                ? item.categories
                : [],

              divisions: Array.isArray(
                item.divisions
              )
                ? item.divisions
                : [],

              condition: item.condition || "",

              descriptionText: cleanDescription(
                item.descriptionHtml
              ),

              imageUrls: Array.isArray(
                item.imageUrls
              )
                ? item.imageUrls
                : [],

              dailyPrice:
                Number(item.dailyPrice) || 0,

              quantity:
                Number(item.quantity) || 0,

              availableQuantity:
                Number(item.availableQuantity) || 0,

              ownerId,

              owner:
                ownerMap.get(ownerId) || null,

              status: item.status || "pending",

              reviewReason:
                item.reviewReason || "",

              reviewedAt:
                item.reviewedAt || null,

              createdAt:
                item.createdAt || null,

              updatedAt:
                item.updatedAt || null,
            };
          }
        );

        res.set("Cache-Control", "no-store");

        return res.status(200).json({
          success: true,

          equipment: serializedEquipment,

          stats: {
            total: allCount,
            approved: approvedCount,
            pending: pendingCount,
            rejected: rejectedCount,
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
          "Admin All Equipment error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to load equipment.",
        });
      }
    }
  );
}
