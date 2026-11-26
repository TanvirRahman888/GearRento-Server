
import { ObjectId } from "mongodb";

// ======================================
// Helpers
// ======================================

function isValidId(id) {
  return (
    typeof id === "string" &&
    /^[a-f0-9]{24}$/i.test(id)
  );
}

function getPage(value) {
  const page = Number(value ?? 1);

  return Number.isSafeInteger(page) && page > 0
    ? Math.min(page, 10000)
    : 1;
}

// ======================================
// Register Favorites Routes
// ======================================

export function registerFavoriteRoutes(
  app,
  { getDb, verifyJWT, requireRole }
) {
  const auth = [
    verifyJWT,
    requireRole("customer"),
  ];

  // ====================================
  // GET /favorites
  // ====================================

  app.get("/favorites", ...auth, async (req, res) => {
    try {
      const db = getDb();

      const collection = db.collection("favorites");

      const customerId = req.authUser.id;
      const page = getPage(req.query.page);
      const limit = 12;

      const filter = { customerId };

      const [total, records] = await Promise.all([
        collection.countDocuments(filter),

        collection
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);

      // Load equipment in one query rather
      // than making a query for every favorite.

      const equipmentIds = records.map(
        (item) => item.equipmentId
      );

      const equipment = equipmentIds.length
        ? await db
            .collection("equipment")
            .find(
              {
                _id: { $in: equipmentIds },
              },
              {
                projection: {
                  name: 1,
                  categories: 1,
                  divisions: 1,
                  condition: 1,
                  dailyPrice: 1,
                  imageUrls: 1,
                  availableQuantity: 1,
                  status: 1,
                  featureExpiresAt: 1,
                },
              }
            )
            .toArray()
        : [];

      const equipmentMap = new Map(
        equipment.map((item) => [
          item._id.toString(),
          item,
        ])
      );

      const favorites = records.map((item) => {
        const equipmentId =
          item.equipmentId.toString();

        const product =
          equipmentMap.get(equipmentId);

        const isAvailable =
          product?.status === "approved";

        return {
          _id: item._id.toString(),
          equipmentId,
          savedAt: item.createdAt,

          equipment: isAvailable
            ? {
                _id: equipmentId,
                name: product.name,
                categories:
                  product.categories ?? [],
                divisions:
                  product.divisions ?? [],
                condition: product.condition,
                dailyPrice: product.dailyPrice,
                imageUrls:
                  product.imageUrls ?? [],
                availableQuantity:
                  product.availableQuantity ?? 0,

                isFeatured:
                  product.featureExpiresAt
                    instanceof Date &&
                  product.featureExpiresAt >
                    new Date(),
              }
            : null,
        };
      });

      res.set("Cache-Control", "no-store");

      return res.status(200).json({
        success: true,
        favorites,

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error(
        "Get favorites error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load favorites.",
      });
    }
  });

  // ====================================
  // GET /favorites/:id/status
  // ====================================

  app.get(
    "/favorites/:equipmentId/status",
    ...auth,
    async (req, res) => {
      try {
        const { equipmentId } = req.params;

        if (!isValidId(equipmentId)) {
          return res.status(400).json({
            success: false,
            error: "Invalid equipment ID.",
          });
        }

        const favorite = await getDb()
          .collection("favorites")
          .findOne(
            {
              customerId: req.authUser.id,
              equipmentId:
                new ObjectId(equipmentId),
            },
            {
              projection: { _id: 1 },
            }
          );

        res.set("Cache-Control", "no-store");

        return res.json({
          success: true,
          isFavorite: Boolean(favorite),
        });
      } catch (error) {
        console.error(
          "Check favorite status:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to check favorite.",
        });
      }
    }
  );

  // ====================================
  // POST /favorites/:equipmentId
  // ====================================

  app.post(
    "/favorites/:equipmentId",
    ...auth,
    async (req, res) => {
      try {
        const { equipmentId } = req.params;

        if (!isValidId(equipmentId)) {
          return res.status(400).json({
            success: false,
            error: "Invalid equipment ID.",
          });
        }

        const db = getDb();

        const id = new ObjectId(equipmentId);

        // Only approved equipment can be
        // added to a customer's favorites.

        const equipment = await db
          .collection("equipment")
          .findOne(
            {
              _id: id,
              status: "approved",
            },
            {
              projection: { _id: 1 },
            }
          );

        if (!equipment) {
          return res.status(404).json({
            success: false,
            error:
              "Equipment is not available.",
          });
        }

        const collection =
          db.collection("favorites");

        const filter = {
          customerId: req.authUser.id,
          equipmentId: id,
        };

        try {
          await collection.updateOne(
            filter,
            {
              $setOnInsert: {
                createdAt: new Date(),
              },
            },
            {
              upsert: true,
            }
          );
        } catch (error) {
          // Concurrent duplicate saves are
          // harmless when the unique index
          // already contains the favorite.
          if (error?.code !== 11000) {
            throw error;
          }

          const existing =
            await collection.findOne(filter);

          if (!existing) {
            throw error;
          }
        }

        return res.status(200).json({
          success: true,
          isFavorite: true,
          message: "Added to favorites.",
        });
      } catch (error) {
        console.error(
          "Add favorite error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to save equipment.",
        });
      }
    }
  );

  // ====================================
  // DELETE /favorites/:equipmentId
  // ====================================

  app.delete(
    "/favorites/:equipmentId",
    ...auth,
    async (req, res) => {
      try {
        const { equipmentId } = req.params;

        if (!isValidId(equipmentId)) {
          return res.status(400).json({
            success: false,
            error: "Invalid equipment ID.",
          });
        }

        await getDb()
          .collection("favorites")
          .deleteOne({
            customerId: req.authUser.id,
            equipmentId:
              new ObjectId(equipmentId),
          });

        return res.status(200).json({
          success: true,
          isFavorite: false,
          message: "Removed from favorites.",
        });
      } catch (error) {
        console.error(
          "Remove favorite error:",
          error
        );

        return res.status(500).json({
          success: false,
          error:
            "Unable to remove favorite.",
        });
      }
    }
  );
}
