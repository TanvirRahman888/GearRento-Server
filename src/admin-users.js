
import { ObjectId } from "mongodb";

const USERS_COLLECTION = "user";
const ROLES = ["customer", "owner", "admin"];

class AdminUserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function idCandidates(id) {
  const ids = [id];

  if (/^[a-f0-9]{24}$/i.test(id)) {
    ids.push(new ObjectId(id));
  }

  return ids;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sendError(res, error, label) {
  if (error instanceof AdminUserError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
    });
  }

  console.error(label, error);

  return res.status(500).json({
    success: false,
    error: "Unable to complete this action.",
  });
}

// ======================================
// Register Admin User Routes
// ======================================

export function registerAdminUserRoutes(
  app,
  { getDb, getMongoClient, verifyJWT, requireRole }
) {
  // dotenv.config() has already run by
  // the time this function is called.
  const primaryAdminId =
    process.env.PRIMARY_ADMIN_ID?.trim();

  if (!primaryAdminId) {
    throw new Error(
      "Missing PRIMARY_ADMIN_ID in backend .env"
    );
  }

  if (typeof getMongoClient !== "function") {
    throw new Error(
      "getMongoClient is required for Admin Users"
    );
  }

  const usersCollection = () =>
    getDb().collection(USERS_COLLECTION);

  const isPrimaryAdmin = (id) =>
    id === primaryAdminId;

  // ====================================
  // Verify actual Admin role in MongoDB
  // ====================================

  async function requireStoredAdmin(req, res, next) {
    try {
      const actorId = req.authUser?.id;

      if (!actorId) {
        return res.status(401).json({
          success: false,
          error: "Authentication required.",
        });
      }

      const actor = await usersCollection().findOne(
        {
          _id: {
            $in: idCandidates(actorId),
          },
          role: "admin",
        },
        {
          projection: { role: 1 },
        }
      );

      if (!actor) {
        return res.status(403).json({
          success: false,
          error: "Admin access required.",
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  }

  const adminAuth = [
    verifyJWT,
    requireRole("admin"),
    requireStoredAdmin,
  ];

  // ====================================
  // GET /admin/users
  // ====================================

  app.get(
    "/admin/users",
    ...adminAuth,
    async (req, res) => {
      try {
        const search =
          typeof req.query.q === "string"
            ? req.query.q.trim().slice(0, 100)
            : "";

        const requestedRole =
          typeof req.query.role === "string"
            ? req.query.role
            : "all";

        const role = [
          "all",
          ...ROLES,
        ].includes(requestedRole)
          ? requestedRole
          : "all";

        const requestedPage = Number(
          req.query.page || 1
        );

        const page =
          Number.isSafeInteger(requestedPage) &&
          requestedPage >= 1
            ? Math.min(requestedPage, 10000)
            : 1;

        const limit = 10;
        const filter = {};

        if (role !== "all") {
          filter.role = role;
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
              email: {
                $regex: pattern,
                $options: "i",
              },
            },
          ];
        }

        const collection = usersCollection();

        const [total, users] = await Promise.all([
          collection.countDocuments(filter),

          collection
            .find(filter, {
              projection: {
                name: 1,
                email: 1,
                emailVerified: 1,
                image: 1,
                role: 1,
                accountType: 1,
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

        const primary =
          isPrimaryAdmin(req.authUser.id);

        res.set("Cache-Control", "no-store");

        return res.status(200).json({
          success: true,

          users: users.map((user) => ({
            id: user._id.toString(),

            name: user.name || "Unnamed User",
            email: user.email || "",
            emailVerified:
              user.emailVerified === true,
            image: user.image || null,

            role: user.role || "customer",
            accountType:
              user.accountType || "customer",

            createdAt: user.createdAt
              ? new Date(
                  user.createdAt
                ).toISOString()
              : null,

            isPrimaryAdmin: isPrimaryAdmin(
              user._id.toString()
            ),
          })),

          permissions: {
            canAssignAdmin: primary,
            canManageAdmins: primary,
            canDeleteUsers: primary,
          },

          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Admin users list error:"
        );
      }
    }
  );

  // ====================================
  // PATCH /admin/users/:id/role
  // ====================================

  app.patch(
    "/admin/users/:id/role",
    ...adminAuth,
    async (req, res) => {
      const actorId = req.authUser.id;
      const targetId = req.params.id;
      const nextRole = req.body?.role;

      if (
        typeof targetId !== "string" ||
        !targetId ||
        targetId.length > 128
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid user ID.",
        });
      }

      if (!ROLES.includes(nextRole)) {
        return res.status(400).json({
          success: false,
          error: "Invalid target role.",
        });
      }

      if (
        targetId === actorId ||
        isPrimaryAdmin(targetId)
      ) {
        return res.status(403).json({
          success: false,
          error:
            "Your own account and the Main Admin account are protected.",
        });
      }

      const session =
        getMongoClient().startSession();

      try {
        const changed = await session.withTransaction(
          async () => {
            const db = getDb();
            const collection = usersCollection();

            const user = await collection.findOne(
              {
                _id: {
                  $in: idCandidates(targetId),
                },
              },
              { session }
            );

            if (!user) {
              throw new AdminUserError(
                404,
                "User not found."
              );
            }

            const actualId = user._id.toString();
            const previousRole = user.role;

            if (
              actualId === actorId ||
              isPrimaryAdmin(actualId)
            ) {
              throw new AdminUserError(
                403,
                "This account is protected."
              );
            }

            if (!ROLES.includes(previousRole)) {
              throw new AdminUserError(
                409,
                "Unsupported current role."
              );
            }

            if (previousRole === nextRole) {
              throw new AdminUserError(
                409,
                "User already has this role."
              );
            }

            // Only Main Admin can grant
            // or remove Admin permissions.
            if (
              (previousRole === "admin" ||
                nextRole === "admin") &&
              !isPrimaryAdmin(actorId)
            ) {
              throw new AdminUserError(
                403,
                "Only the Main Admin can manage Admin roles."
              );
            }

            const now = new Date();

            const updates = {
              role: nextRole,
              updatedAt: now,
            };

            if (
              nextRole === "customer" ||
              nextRole === "owner"
            ) {
              updates.accountType = nextRole;
            }

            const result = await collection.updateOne(
              {
                _id: user._id,
                role: previousRole,
              },
              {
                $set: updates,
              },
              { session }
            );

            if (result.modifiedCount !== 1) {
              throw new AdminUserError(
                409,
                "Role changed. Refresh and try again."
              );
            }

            // When an Owner loses their role,
            // withdraw active equipment listings.
            // Preserve equipment documents and
            // existing rental/payment history.
            let withdrawnListings = 0;

            if (
              previousRole === "owner" &&
              nextRole !== "owner"
            ) {
              const equipmentResult = await db
                .collection("equipment")
                .updateMany(
                  {
                    ownerId: {
                      $in: idCandidates(actualId),
                    },
                    status: {
                      $in: ["approved", "pending"],
                    },
                  },
                  {
                    $set: {
                      status: "rejected",
                      reviewReason:
                        "Owner role removed. Listing withdrawn pending reassignment or reapproval.",
                      availableQuantity: 0,
                      updatedAt: now,
                    },
                  },
                  { session }
                );

              withdrawnListings =
                equipmentResult.modifiedCount;
            }

            // Remove database-backed sessions.
            // Existing JWTs must ALSO be checked
            // against the current MongoDB role.
            await db.collection("session").deleteMany(
              {
                userId: {
                  $in: idCandidates(actualId),
                },
              },
              { session }
            );

            // Audit role change
            await db
              .collection("adminAuditLogs")
              .insertOne(
                {
                  actorId,
                  targetId: actualId,
                  action: "user.role_changed",
                  previousRole,
                  nextRole,
                  withdrawnListings,
                  createdAt: now,
                },
                { session }
              );

            return {
              id: actualId,
              role: nextRole,
              withdrawnListings,
            };
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

        return res.status(200).json({
          success: true,
          message:
            `Role changed to ${changed.role}. ` +
            "The user must sign in again.",
          user: changed,
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Change user role error:"
        );
      } finally {
        await session.endSession();
      }
    }
  );

  // ====================================
  // DELETE /admin/users/:id
  // Main Admin Only
  // ====================================

  app.delete(
    "/admin/users/:id",
    ...adminAuth,
    async (req, res) => {
      const actorId = req.authUser.id;
      const targetId = req.params.id;

      if (!isPrimaryAdmin(actorId)) {
        return res.status(403).json({
          success: false,
          error:
            "Only the Main Admin can delete users.",
        });
      }

      if (
        typeof targetId !== "string" ||
        !targetId ||
        targetId.length > 128
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid user ID.",
        });
      }

      if (
        targetId === actorId ||
        isPrimaryAdmin(targetId)
      ) {
        return res.status(403).json({
          success: false,
          error:
            "The Main Admin cannot be deleted.",
        });
      }

      const session =
        getMongoClient().startSession();

      try {
        const deleted = await session.withTransaction(
          async () => {
            const db = getDb();
            const users = usersCollection();

            const user = await users.findOne(
              {
                _id: {
                  $in: idCandidates(targetId),
                },
              },
              { session }
            );

            if (!user) {
              throw new AdminUserError(
                404,
                "User not found."
              );
            }

            const actualId = user._id.toString();

            if (
              actualId === actorId ||
              isPrimaryAdmin(actualId)
            ) {
              throw new AdminUserError(
                403,
                "The Main Admin cannot be deleted."
              );
            }

            const ids = idCandidates(actualId);
            const now = new Date();

            // Hide this user's equipment from
            // the marketplace BEFORE deleting
            // their authentication records.
            const equipmentResult = await db
              .collection("equipment")
              .updateMany(
                {
                  ownerId: {
                    $in: ids,
                  },
                  status: {
                    $in: ["approved", "pending"],
                  },
                },
                {
                  $set: {
                    status: "rejected",
                    reviewReason:
                      "Owner account deleted. Listing withdrawn.",
                    availableQuantity: 0,
                    updatedAt: now,
                  },
                },
                { session }
              );

            // Delete Better Auth sessions.
            await db
              .collection("session")
              .deleteMany(
                {
                  userId: { $in: ids },
                },
                { session }
              );

            // Delete login credentials and
            // linked OAuth accounts.
            await db
              .collection("account")
              .deleteMany(
                {
                  userId: { $in: ids },
                },
                { session }
              );

            // Remove pending Owner applications.
            await db
              .collection("ownerRequests")
              .deleteMany(
                {
                  userId: { $in: ids },
                },
                { session }
              );

            // Remove relevant Better Auth
            // verification records, if present.
            if (user.email) {
              await db
                .collection("verification")
                .deleteMany(
                  {
                    identifier: user.email,
                  },
                  { session }
                );
            }

            // Permanently delete the user.
            const result = await users.deleteOne(
              {
                _id: user._id,
                role: user.role,
              },
              { session }
            );

            if (result.deletedCount !== 1) {
              throw new AdminUserError(
                409,
                "User changed. Refresh and retry."
              );
            }

            // Keep booking/payment records.
            // They still reference this user ID.
            // Keep historic Admin audit records.
            await db
              .collection("adminAuditLogs")
              .insertOne(
                {
                  actorId,
                  targetId: actualId,
                  action: "user.deleted",
                  previousRole: user.role,
                  withdrawnListings:
                    equipmentResult.modifiedCount,
                  createdAt: now,
                },
                { session }
              );

            return {
              id: actualId,
              withdrawnListings:
                equipmentResult.modifiedCount,
            };
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

        return res.status(200).json({
          success: true,
          message:
            "User account permanently deleted.",
          deletedUserId: deleted.id,
          withdrawnListings:
            deleted.withdrawnListings,
        });
      } catch (error) {
        return sendError(
          res,
          error,
          "Delete user error:"
        );
      } finally {
        await session.endSession();
      }
    }
  );
}
