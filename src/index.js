import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { jwtVerify, createRemoteJWKSet } from "jose";
import sanitizeHtml from "sanitize-html";
import { MongoClient, ObjectId } from "mongodb";

import {
  registerStripeWebhook,
  registerBookingRoutes,
} from "./stripe-bookings.js";

import { registerAdminUserRoutes } from "./admin-users.js";
import { registerAdminEquipmentRoutes } from "./admin-equipment.js";
import { registerPlatformSettingsRoutes } from "./platform-settings.js";
import { registerOwnerAvailabilityRoutes } from "./owner-availability.js";
import { registerCustomerRentalHistoryRoutes } from "./customer-rental-history.js";
import { registerFeaturedEquipmentRoutes } from "./featured-equipment.js";

dotenv.config();

// ==========================================
// EXPRESS CONFIGURATION
// ==========================================

const app = express();

const PORT = Number(process.env.PORT || 5000);

const CLIENT_URL = process.env.CLIENT_URL?.replace(/\/+$/, "");

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "GearRento";

// Avoid crashing the entire serverless function
// when an environment variable is missing.

if (!CLIENT_URL || !BETTER_AUTH_URL || !MONGODB_URI) {
  console.warn("GearRento configuration is incomplete:", {
    hasClientUrl: Boolean(CLIENT_URL),
    hasBetterAuthUrl: Boolean(BETTER_AUTH_URL),
    hasMongoUri: Boolean(MONGODB_URI),
  });
}

// ==========================================
// MONGODB CONFIGURATION
// ==========================================

let client = null;
let db = null;
let mongoConfigurationError = null;

try {
  if (MONGODB_URI) {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    });

    db = client.db(DB_NAME);
  }
} catch (error) {
  mongoConfigurationError = error;

  console.error("Invalid MongoDB configuration:", error?.message);
}

// ==========================================
// REUSABLE MONGODB CONNECTION
// ==========================================

let mongoConnectionPromise;

async function connectDatabase() {
  if (!client || !db) {
    throw mongoConfigurationError || new Error("MONGODB_URI is missing.");
  }

  if (!mongoConnectionPromise) {
    mongoConnectionPromise = client
      .connect()
      .then(() => {
        console.log("GearRento MongoDB connected successfully");

        return db;
      })
      .catch((error) => {
        mongoConnectionPromise = undefined;

        throw error;
      });
  }

  return mongoConnectionPromise;
}

// ==========================================
// CORS MIDDLEWARE
// ==========================================

app.use(
  cors({
    origin: CLIENT_URL || false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ==========================================
// HEALTH CHECK
// ==========================================

// Health checks do not require MongoDB.
// Useful for diagnosing Vercel deployments.

function sendHealth(req, res) {
  return res.status(200).json({
    success: true,
    message: "GearRento API is running",
  });
}

app.get("/", sendHealth);
app.get("/health", sendHealth);

// ==========================================
// DATABASE CONNECTION MIDDLEWARE
// ==========================================

// Connect MongoDB before processing database
// dependent routes.
//
// This does not modify request bodies, so
// Stripe webhook signature checking still works.

app.use(async (req, res, next) => {
  try {
    await connectDatabase();

    next();
  } catch (error) {
    console.error("MongoDB connection failed:", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });

    return res.status(503).json({
      success: false,
      error: "Database temporarily unavailable.",
    });
  }
});

// ==========================================
// STRIPE WEBHOOK
// ==========================================

// IMPORTANT:
// Register Stripe webhook before express.json().
// The Stripe webhook needs the raw request body.

registerStripeWebhook(
  app,
  () => db,
  () => client,
);

// ==========================================
// JSON MIDDLEWARE
// ==========================================

app.use(express.json({ limit: "100kb" }));

// ==========================================
// BETTER AUTH JWT CONFIGURATION
// ==========================================

let JWKS = null;

try {
  if (BETTER_AUTH_URL) {
    JWKS = createRemoteJWKSet(new URL(`${BETTER_AUTH_URL}/api/auth/jwks`));
  }
} catch (error) {
  console.error("Invalid Better Auth URL:", error?.message);
}

// ==========================================
// JWT AUTHENTICATION MIDDLEWARE
// ==========================================

async function verifyJWT(req, res, next) {
  const authorization = req.get("Authorization") || "";

  const match = authorization.match(/^Bearer (.+)$/i);

  if (!match) {
    return res.status(401).json({
      success: false,
      error: "Authentication token required.",
    });
  }

  if (!JWKS) {
    return res.status(503).json({
      success: false,
      error: "Authentication provider is not configured.",
    });
  }

  try {
    const { payload } = await jwtVerify(match[1], JWKS, {
      issuer: BETTER_AUTH_URL,
      audience: BETTER_AUTH_URL,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp"],
    });

    // Validate user identity

    if (typeof payload.sub !== "string" || !payload.sub) {
      return res.status(401).json({
        success: false,
        error: "Invalid user identity.",
      });
    }

    // Validate supported roles

    const supportedRoles = ["admin", "owner", "customer"];

    if (!supportedRoles.includes(payload.role)) {
      return res.status(403).json({
        success: false,
        error: "Invalid user role.",
      });
    }

    // ======================================
    // VERIFY CURRENT DATABASE ROLE
    // ======================================

    const idCandidates = [payload.sub];

    if (/^[a-f0-9]{24}$/i.test(payload.sub)) {
      idCandidates.push(new ObjectId(payload.sub));
    }

    const storedUser = await db.collection("user").findOne(
      {
        _id: {
          $in: idCandidates,
        },
      },
      {
        projection: {
          role: 1,
        },
      },
    );

    if (!storedUser) {
      return res.status(401).json({
        success: false,
        error: "User account no longer exists.",
      });
    }

    if (storedUser.role !== payload.role) {
      return res.status(403).json({
        success: false,
        error:
          "Your account role has changed. Please sign out and sign in again.",
      });
    }

    // Attach authenticated user

    req.authUser = {
      id: payload.sub,
      role: storedUser.role,
    };

    next();
  } catch (error) {
    console.error("JWT verification failed:", {
      name: error.name,
      code: error.code,
      message: error.message,
    });

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token.",
    });
  }
}

// ==========================================
// ROLE AUTHORIZATION MIDDLEWARE
// ==========================================

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    if (!allowedRoles.includes(req.authUser.role)) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission.",
      });
    }

    next();
  };
}

// ==========================================
// EQUIPMENT CATEGORIES
// ==========================================

const allowedCategories = [
  "Photography",
  "Power Tools",
  "Camping",
  "Audio & Video",
  "Events",
  "Sports",
  "Other",
  "Construction Equipment",
  "Gardening",
  "Computers & IT",
  "Home Appliances",
  "Musical Instruments",
  "Medical Equipment",
  "Automotive",
];

// ==========================================
// BANGLADESH DIVISIONS
// ==========================================

const allowedDivisions = [
  "Dhaka",
  "Chattogram",
  "Rajshahi",
  "Khulna",
  "Barishal",
  "Sylhet",
  "Rangpur",
  "Mymensingh",
];

// ==========================================
// EQUIPMENT CONDITIONS
// ==========================================

const allowedConditions = [
  "new",
  "like-new",
  "excellent",
  "very-good",
  "good",
  "fair",
  "refurbished",
  "used-tested",
];

// ==========================================
// EQUIPMENT HELPERS
// ==========================================

function validImageUrl(value) {
  if (typeof value !== "string" || value.length > 1000) {
    return false;
  }

  try {
    const url = new URL(value.trim());

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanEquipmentDescription(html) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "strong",
      "em",
      "s",
      "h2",
      "h3",
      "ul",
      "ol",
      "li",
      "blockquote",
      "br",
    ],
    allowedAttributes: {},
  });
}

function getPlainDescription(html) {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, " ")
    .trim();
}

function getOwnerEquipmentFilter(req) {
  const id = req.params.id;

  if (!/^[a-f0-9]{24}$/i.test(id)) {
    return null;
  }

  return {
    _id: new ObjectId(id),
    ownerId: req.authUser.id,
  };
}

// ==========================================
// POST /equipment/add
// OWNER ONLY
// ==========================================

app.post(
  "/equipment/add",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    const {
      name,
      categories,
      condition,
      divisions,
      descriptionHtml,
      imageUrls,
      dailyPrice,
      quantity,
    } = req.body ?? {};

    const valid =
      typeof name === "string" &&
      name.trim().length >= 3 &&
      name.trim().length <= 120 &&
      Array.isArray(categories) &&
      categories.length >= 1 &&
      categories.length <= allowedCategories.length &&
      categories.every((category) => allowedCategories.includes(category)) &&
      allowedConditions.includes(condition) &&
      Array.isArray(divisions) &&
      divisions.length >= 1 &&
      divisions.length <= allowedDivisions.length &&
      divisions.every((division) => allowedDivisions.includes(division)) &&
      Array.isArray(imageUrls) &&
      imageUrls.length >= 1 &&
      imageUrls.length <= 5 &&
      imageUrls.every(validImageUrl) &&
      typeof descriptionHtml === "string" &&
      descriptionHtml.length <= 12000 &&
      typeof dailyPrice === "number" &&
      Number.isFinite(dailyPrice) &&
      dailyPrice > 0 &&
      dailyPrice <= 1000000 &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 10000;

    if (!valid) {
      return res.status(400).json({
        success: false,
        error: "Invalid equipment information.",
      });
    }

    const cleanDescription = cleanEquipmentDescription(descriptionHtml);

    const plainDescription = getPlainDescription(cleanDescription);

    if (plainDescription.length < 20 || plainDescription.length > 3000) {
      return res.status(400).json({
        success: false,
        error: "Description must contain 20–3000 characters.",
      });
    }

    try {
      const now = new Date();

      const equipment = {
        name: name.trim(),

        categories: [...new Set(categories)],
        condition,
        divisions: [...new Set(divisions)],

        descriptionHtml: cleanDescription,

        imageUrls: imageUrls.map((url) => url.trim()),

        dailyPrice,
        quantity,
        availableQuantity: quantity,

        ownerId: req.authUser.id,

        status: "pending",

        createdAt: now,
        updatedAt: now,
      };

      const result = await db.collection("equipment").insertOne(equipment);

      return res.status(201).json({
        success: true,
        message: "Equipment submitted for approval.",
        id: result.insertedId.toString(),
      });
    } catch (error) {
      console.error("Equipment creation failed:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to save equipment.",
      });
    }
  },
);

// ==========================================
// REGISTER BACKEND ROUTE MODULES
// ==========================================

// Register routes synchronously so Vercel
// can handle incoming requests correctly.

const routeDependencies = {
  getDb: () => db,
  getMongoClient: () => client,
  verifyJWT,
  requireRole,
};

if (db) {
  registerAdminUserRoutes(app, routeDependencies);

  registerBookingRoutes(app, routeDependencies);

  registerAdminEquipmentRoutes(app, routeDependencies);

  registerPlatformSettingsRoutes(app, routeDependencies);

  registerOwnerAvailabilityRoutes(app, routeDependencies);

  registerCustomerRentalHistoryRoutes(app, routeDependencies);

  registerFeaturedEquipmentRoutes(app, routeDependencies);
} else {
  console.error(
    "Equipment and booking routes unavailable: MongoDB is not configured.",
  );
}

// ==========================================
// DATABASE INDEXES
// ==========================================

// MongoDB indexes are initialized during
// local startup, not on every Vercel request.
//
// Ensure these indexes exist in Atlas before
// relying on them in production.

async function ensureIndexes() {
  if (!db) {
    throw new Error("MongoDB is not configured.");
  }

  const ownerRequests = db.collection("ownerRequests");
  const equipment = db.collection("equipment");
  const bookings = db.collection("bookings");

  const equipmentFeatures = db.collection("equipmentFeatures");

  // Owner request index

  await ownerRequests.createIndex({ userId: 1 }, { unique: true });

  // Equipment indexes

  await equipment.createIndex({
    ownerId: 1,
    createdAt: -1,
  });

  await equipment.createIndex({
    status: 1,
    createdAt: -1,
  });

  await equipment.createIndex({
    status: 1,
    featureExpiresAt: -1,
  });

  // Booking indexes

  await bookings.createIndex({
    customerId: 1,
    paymentStatus: 1,
    status: 1,
    endDate: -1,
  });

  await bookings.createIndex({
    equipmentId: 1,
    status: 1,
    startDate: 1,
    endDate: 1,
  });

  await bookings.createIndex({
    customerId: 1,
    createdAt: -1,
  });

  await bookings.createIndex({
    ownerId: 1,
    paymentStatus: 1,
    status: 1,
    createdAt: -1,
  });

  await bookings.createIndex({
    status: 1,
    paymentStatus: 1,
    createdAt: -1,
  });

  await bookings.createIndex({
    createdAt: -1,
  });

  await bookings.createIndex(
    {
      stripeSessionId: 1,
    },
    {
      unique: true,
      partialFilterExpression: {
        stripeSessionId: {
          $type: "string",
        },
      },
    },
  );

  // Featured equipment indexes

  await equipmentFeatures.createIndex({
    equipmentId: 1,
    createdAt: -1,
  });

  await equipmentFeatures.createIndex(
    {
      stripeSessionId: 1,
    },
    {
      unique: true,
      partialFilterExpression: {
        stripeSessionId: {
          $type: "string",
        },
      },
    },
  );

  // Admin audit logs

  await db.collection("adminAuditLogs").createIndex({
    actorId: 1,
    createdAt: -1,
  });
}

// ==========================================
// GET /equipment/mine
// OWNER ONLY
// ==========================================

app.get(
  "/equipment/mine",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    try {
      const ownerId = req.authUser.id;

      const requestedPage = Number(req.query.page);

      const page =
        Number.isSafeInteger(requestedPage) && requestedPage > 0
          ? requestedPage
          : 1;

      const limit = 9;
      const skip = (page - 1) * limit;

      const collection = db.collection("equipment");

      const filter = { ownerId };

      const [total, equipment] = await Promise.all([
        collection.countDocuments(filter),

        collection
          .find(filter, {
            projection: {
              descriptionHtml: 0,
            },
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
      ]);

      return res.status(200).json({
        success: true,

        equipment: equipment.map((item) => ({
          ...item,
          _id: item._id.toString(),
        })),

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Failed to fetch owner's equipment:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load your equipment.",
      });
    }
  },
);

// ==========================================
// GET /equipment/mine/:id
// OWNER ONLY
// ==========================================

app.get(
  "/equipment/mine/:id",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    const filter = getOwnerEquipmentFilter(req);

    if (!filter) {
      return res.status(400).json({
        error: "Invalid equipment ID.",
      });
    }

    try {
      const equipment = await db.collection("equipment").findOne(filter);

      if (!equipment) {
        return res.status(404).json({
          error: "Equipment not found.",
        });
      }

      const cleanDescription = cleanEquipmentDescription(
        equipment.descriptionHtml || "",
      );

      return res.status(200).json({
        success: true,

        equipment: {
          ...equipment,
          _id: equipment._id.toString(),
          descriptionHtml: cleanDescription,
          descriptionText: getPlainDescription(cleanDescription),
        },
      });
    } catch (error) {
      console.error("Equipment details error:", error);

      return res.status(500).json({
        error: "Unable to load equipment details.",
      });
    }
  },
);

// ==========================================
// PATCH /equipment/mine/:id
// OWNER ONLY
// ==========================================

app.patch(
  "/equipment/mine/:id",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    const filter = getOwnerEquipmentFilter(req);

    if (!filter) {
      return res.status(400).json({
        error: "Invalid equipment ID.",
      });
    }

    const {
      name,
      categories,
      condition,
      divisions,
      descriptionHtml,
      imageUrls,
      dailyPrice,
      quantity,
    } = req.body ?? {};

    const valid =
      typeof name === "string" &&
      name.trim().length >= 3 &&
      name.trim().length <= 120 &&
      Array.isArray(categories) &&
      categories.length >= 1 &&
      categories.length <= allowedCategories.length &&
      categories.every((item) => allowedCategories.includes(item)) &&
      allowedConditions.includes(condition) &&
      Array.isArray(divisions) &&
      divisions.length >= 1 &&
      divisions.length <= allowedDivisions.length &&
      divisions.every((item) => allowedDivisions.includes(item)) &&
      Array.isArray(imageUrls) &&
      imageUrls.length >= 1 &&
      imageUrls.length <= 5 &&
      imageUrls.every(validImageUrl) &&
      typeof descriptionHtml === "string" &&
      descriptionHtml.length <= 12000 &&
      typeof dailyPrice === "number" &&
      Number.isFinite(dailyPrice) &&
      dailyPrice > 0 &&
      dailyPrice <= 1000000 &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 10000;

    if (!valid) {
      return res.status(400).json({
        error: "Invalid equipment information.",
      });
    }

    const cleanDescription = cleanEquipmentDescription(descriptionHtml);

    const descriptionText = getPlainDescription(cleanDescription);

    if (descriptionText.length < 20 || descriptionText.length > 3000) {
      return res.status(400).json({
        error: "Description must contain 20–3000 characters.",
      });
    }

    try {
      const result = await db.collection("equipment").updateOne(filter, {
        $set: {
          name: name.trim(),
          categories: [...new Set(categories)],
          condition,
          divisions: [...new Set(divisions)],
          descriptionHtml: cleanDescription,
          imageUrls: imageUrls.map((url) => url.trim()),
          dailyPrice,
          quantity,
          availableQuantity: quantity,
          status: "pending",
          updatedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({
          error: "Equipment not found.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Equipment updated successfully.",
      });
    } catch (error) {
      console.error("Equipment update error:", error);

      return res.status(500).json({
        error: "Unable to update equipment.",
      });
    }
  },
);

// ==========================================
// DELETE /equipment/mine/:id
// OWNER ONLY
// ==========================================

app.delete(
  "/equipment/mine/:id",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    const filter = getOwnerEquipmentFilter(req);

    if (!filter) {
      return res.status(400).json({
        error: "Invalid equipment ID.",
      });
    }

    try {
      const result = await db.collection("equipment").deleteOne(filter);

      if (result.deletedCount === 0) {
        return res.status(404).json({
          error: "Equipment not found.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Equipment deleted successfully.",
      });
    } catch (error) {
      console.error("Equipment deletion error:", error);

      return res.status(500).json({
        error: "Unable to delete equipment.",
      });
    }
  },
);

// ==========================================
// GET /equipment/pending
// ADMIN ONLY
// ==========================================

app.get(
  "/equipment/pending",
  verifyJWT,
  requireRole("admin"),
  async (req, res) => {
    try {
      const requestedPage = Number(req.query.page ?? 1);

      const page =
        Number.isSafeInteger(requestedPage) && requestedPage >= 1
          ? requestedPage
          : 1;

      const limit = 10;

      const filter = {
        status: "pending",
      };

      const collection = db.collection("equipment");

      const [total, documents] = await Promise.all([
        collection.countDocuments(filter),

        collection
          .find(filter)
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);

      const equipment = documents.map((item) => ({
        _id: item._id.toString(),
        name: item.name,
        categories: item.categories,
        divisions: item.divisions,
        condition: item.condition,
        dailyPrice: item.dailyPrice,
        quantity: item.quantity,
        imageUrls: item.imageUrls,
        ownerId: item.ownerId,
        status: item.status,
        createdAt: item.createdAt,

        descriptionText: sanitizeHtml(item.descriptionHtml || "", {
          allowedTags: [],
          allowedAttributes: {},
        }).trim(),
      }));

      return res.status(200).json({
        success: true,
        equipment,

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Pending equipment error:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load pending equipment.",
      });
    }
  },
);

// ==========================================
// PATCH /equipment/review/:id
// ADMIN ONLY
// ==========================================

app.patch(
  "/equipment/review/:id",
  verifyJWT,
  requireRole("admin"),
  async (req, res) => {
    const { id } = req.params;

    const { decision, reason } = req.body ?? {};

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({
        error: "Invalid equipment ID.",
      });
    }

    if (decision !== "approve" && decision !== "reject") {
      return res.status(400).json({
        error: "Invalid review decision.",
      });
    }

    const reviewReason = typeof reason === "string" ? reason.trim() : "";

    if (
      decision === "reject" &&
      (reviewReason.length < 5 || reviewReason.length > 500)
    ) {
      return res.status(400).json({
        error: "Provide a rejection reason of 5–500 characters.",
      });
    }

    try {
      const result = await db.collection("equipment").updateOne(
        {
          _id: new ObjectId(id),
          status: "pending",
        },
        {
          $set: {
            status: decision === "approve" ? "approved" : "rejected",

            reviewReason: decision === "reject" ? reviewReason : "",

            reviewedBy: req.authUser.id,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        const exists = await db.collection("equipment").findOne({
          _id: new ObjectId(id),
        });

        return res.status(exists ? 409 : 404).json({
          error: exists
            ? "This listing is no longer pending review."
            : "Equipment not found.",
        });
      }

      return res.status(200).json({
        success: true,
        message:
          decision === "approve"
            ? "Equipment approved successfully."
            : "Equipment rejected successfully.",
      });
    } catch (error) {
      console.error("Equipment review error:", error);

      return res.status(500).json({
        error: "Unable to review equipment.",
      });
    }
  },
);

// ==========================================
// GET /equipment
// PUBLIC EQUIPMENT LIST
// ==========================================

app.get("/equipment", async (req, res) => {
  try {
    const getQuery = (key) =>
      typeof req.query[key] === "string" ? req.query[key].trim() : "";

    const search = getQuery("q").slice(0, 100);

    const category = getQuery("category");
    const division = getQuery("division");
    const condition = getQuery("condition");
    const sort = getQuery("sort");

    const requestedPage = Number(getQuery("page") || 1);

    const page =
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? Math.min(requestedPage, 100000)
        : 1;

    const limit = 12;

    // ======================================
    // FILTER APPROVED EQUIPMENT
    // ======================================

    const filter = {
      status: "approved",
    };

    // Search equipment names

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.name = {
        $regex: escapedSearch,
        $options: "i",
      };
    }

    // Category filter

    if (category && allowedCategories.includes(category)) {
      filter.categories = category;
    }

    // Division filter

    if (division && allowedDivisions.includes(division)) {
      filter.divisions = division;
    }

    // Condition filter

    if (condition && allowedConditions.includes(condition)) {
      filter.condition = condition;
    }

    // ======================================
    // PRICE FILTERS
    // ======================================

    const minPriceText = getQuery("minPrice");
    const maxPriceText = getQuery("maxPrice");

    const minPrice = Number(minPriceText);
    const maxPrice = Number(maxPriceText);

    const priceFilter = {};

    if (minPriceText && Number.isFinite(minPrice) && minPrice >= 0) {
      priceFilter.$gte = minPrice;
    }

    if (maxPriceText && Number.isFinite(maxPrice) && maxPrice >= 0) {
      priceFilter.$lte = maxPrice;
    }

    if (Object.keys(priceFilter).length > 0) {
      filter.dailyPrice = priceFilter;
    }

    // ======================================
    // SORTING
    // ======================================

    let sortOptions = {
      createdAt: -1,
      _id: -1,
    };

    if (sort === "price-low") {
      sortOptions = {
        dailyPrice: 1,
        _id: -1,
      };
    }

    if (sort === "price-high") {
      sortOptions = {
        dailyPrice: -1,
        _id: -1,
      };
    }

    if (sort === "oldest") {
      sortOptions = {
        createdAt: 1,
        _id: 1,
      };
    }

    // ======================================
    // FEATURED SORTING
    // ======================================

    const collection = db.collection("equipment");

    const now = new Date();

    const featuredSort =
      sort === "newest"
        ? {
            createdAt: -1,
            _id: -1,
          }
        : ["price-low", "price-high", "oldest"].includes(sort)
          ? sortOptions
          : {
              isFeatured: -1,
              ...sortOptions,
            };

    // ======================================
    // MONGODB QUERY
    // ======================================

    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),

      collection
        .aggregate([
          {
            $match: filter,
          },
          {
            $addFields: {
              isFeatured: {
                $and: [
                  {
                    $eq: ["$status", "approved"],
                  },
                  {
                    $gt: ["$featureExpiresAt", now],
                  },
                ],
              },
            },
          },
          {
            $sort: featuredSort,
          },
          {
            $skip: (page - 1) * limit,
          },
          {
            $limit: limit,
          },
          {
            $project: {
              name: 1,
              categories: 1,
              condition: 1,
              divisions: 1,
              dailyPrice: 1,
              quantity: 1,
              availableQuantity: 1,
              imageUrls: 1,
              createdAt: 1,
              isFeatured: 1,
              featureExpiresAt: 1,
            },
          },
        ])
        .toArray(),
    ]);

    return res.status(200).json({
      success: true,

      equipment: documents.map((item) => ({
        ...item,
        _id: item._id.toString(),
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Public equipment API error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to load equipment.",
    });
  }
});

// ==========================================
// GET /equipment/:id
// PUBLIC EQUIPMENT DETAILS
// ==========================================

app.get("/equipment/:id", async (req, res) => {
  const { id } = req.params;

  if (!/^[a-f0-9]{24}$/i.test(id)) {
    return res.status(404).json({
      success: false,
      error: "Equipment not found.",
    });
  }

  try {
    const equipment = await db.collection("equipment").findOne(
      {
        _id: new ObjectId(id),
        status: "approved",
      },
      {
        projection: {
          name: 1,
          categories: 1,
          condition: 1,
          divisions: 1,
          descriptionHtml: 1,
          imageUrls: 1,
          dailyPrice: 1,
          quantity: 1,
          availableQuantity: 1,
          createdAt: 1,
        },
      },
    );

    if (!equipment) {
      return res.status(404).json({
        success: false,
        error: "Equipment not found.",
      });
    }

    const cleanDescription = cleanEquipmentDescription(
      equipment.descriptionHtml || "",
    );

    return res.status(200).json({
      success: true,

      equipment: {
        ...equipment,
        _id: equipment._id.toString(),
        descriptionHtml: cleanDescription,
      },
    });
  } catch (error) {
    console.error("Public equipment details error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to load equipment details.",
    });
  }
});

// ==========================================
// VERCEL EXPRESS EXPORT
// ==========================================

// Vercel uses the exported Express app.
// No app.listen() is required on Vercel.

export default app;

// ==========================================
// LOCAL DEVELOPMENT SERVER
// ==========================================

if (!process.env.VERCEL) {
  (async () => {
    // Connect MongoDB locally
    await connectDatabase();

    // Create required MongoDB indexes
    await ensureIndexes();

    // Start local HTTP server
    app.listen(PORT, () => {
      console.log(`GearRento API running at http://localhost:${PORT}`);
    });
  })().catch((error) => {
    console.error("Local GearRento startup failed:", error);

    process.exitCode = 1;
  });
}

