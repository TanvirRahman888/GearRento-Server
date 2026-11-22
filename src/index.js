import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { jwtVerify, createRemoteJWKSet } from "jose";
import sanitizeHtml from "sanitize-html";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config();

// ======================================
// Express Configuration
// ======================================

const app = express();

const PORT = process.env.PORT || 5000;

const CLIENT_URL = process.env.CLIENT_URL;
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");

if (!CLIENT_URL || !BETTER_AUTH_URL || !process.env.MONGODB_URI) {
  throw new Error(
    "Missing CLIENT_URL, BETTER_AUTH_URL, or MONGODB_URI in .env",
  );
}

// ======================================
// Middlewares
// ======================================

// Allow requests from Next.js
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Parse JSON requests
app.use(express.json({ limit: "100kb" }));

// ======================================
// MongoDB Configuration
// ======================================

const client = new MongoClient(process.env.MONGODB_URI);

const db = client.db(process.env.DB_NAME || "GearRento");

// ======================================
// Better Auth JWT Verification
// ======================================

// Better Auth exposes its public signing keys
// through the JWKS endpoint.

const jwksURL = new URL(`${BETTER_AUTH_URL}/api/auth/jwks`);

// Cache the JWKS verifier
const JWKS = createRemoteJWKSet(new URL(`${BETTER_AUTH_URL}/api/auth/jwks`));

// ======================================
// JWT Authentication Middleware
// ======================================

async function verifyJWT(req, res, next) {
  // Read Authorization header
  const authorization = req.get("Authorization") || "";

  const match = authorization.match(/^Bearer (.+)$/i);

  if (!match) {
    return res.status(401).json({
      success: false,
      error: "Authentication token required.",
    });
  }

  try {
    // Verify signature, issuer, audience and expiry
    const { payload } = await jwtVerify(match[1], JWKS, {
      issuer: BETTER_AUTH_URL,
      audience: BETTER_AUTH_URL,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp"],
    });

    // Verify user identity
    if (typeof payload.sub !== "string" || !payload.sub) {
      return res.status(401).json({
        success: false,
        error: "Invalid user identity.",
      });
    }

    // Only recognize supported roles
    if (
      payload.role !== "admin" &&
      payload.role !== "owner" &&
      payload.role !== "customer"
    ) {
      return res.status(403).json({
        success: false,
        error: "Invalid user role.",
      });
    }

    // Attach verified user information
    req.authUser = {
      id: payload.sub,
      role: payload.role,
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

// ======================================
// Role Authorization Middleware
// ======================================

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

// ======================================
// API Health Check
// ======================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "GearRento API is running",
  });
});

// ======================================
// Equipment Categories
// ======================================

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

// ======================================
// Bangladesh Divisions
// ======================================

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

// ======================================
// Equipment Conditions
// ======================================

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

// ======================================
// Validate Equipment Image URL
// ======================================

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

// ======================================
// POST /equipment/add
// Protected: Owner Only
// ======================================

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

    // ==================================
    // Validate Equipment Fields
    // ==================================

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

    // ==================================
    // Sanitize Rich Text Description
    // ==================================

    const cleanDescription = sanitizeHtml(descriptionHtml, {
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

    // Strip HTML to validate text length
    const plainDescription = sanitizeHtml(cleanDescription, {
      allowedTags: [],
      allowedAttributes: {},
    })
      .replace(/\s+/g, " ")
      .trim();

    if (plainDescription.length < 20 || plainDescription.length > 3000) {
      return res.status(400).json({
        success: false,
        error: "Description must contain 20–3000 characters.",
      });
    }

    // ==================================
    // Save Equipment to MongoDB
    // ==================================

    try {
      const now = new Date();

      const equipment = {
        name: name.trim(),

        // Multiple categories
        categories: [...new Set(categories)],

        // Equipment condition
        condition,

        // Multiple rental divisions
        divisions: [...new Set(divisions)],

        // Sanitized rich-text description
        descriptionHtml: cleanDescription,

        // Maximum 5 images
        imageUrls: imageUrls.map((url) => url.trim()),

        // Rental price
        dailyPrice,

        // Inventory
        quantity,
        availableQuantity: quantity,

        // Owner ID from verified JWT
        ownerId: req.authUser.id,

        // Admin approval
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

// ======================================
// Start Express Server
// ======================================

async function startServer() {
  try {
    await client.connect();

    // Preserve your existing unique index
    await db
      .collection("ownerRequests")
      .createIndex({ userId: 1 }, { unique: true });

    await db.collection("equipment").createIndex({ ownerId: 1, createdAt: -1 });

    console.log("MongoDB connected successfully");

    app.listen(PORT, () => {
      console.log(`GearRento server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

// ======================================
// GET /equipment/mine
// Protected: Owner Only
// ======================================

app.get(
  "/equipment/mine",
  verifyJWT,
  requireRole("owner"),
  async (req, res) => {
    try {
      // Owner ID comes from the verified JWT
      const ownerId = req.authUser.id;

      // Pagination: 9 equipment listings per page
      const requestedPage = Number(req.query.page);
      const page =
        Number.isSafeInteger(requestedPage) && requestedPage > 0
          ? requestedPage
          : 1;

      const limit = 9;
      const skip = (page - 1) * limit;

      const collection = db.collection("equipment");

      // Only fetch equipment belonging to this owner
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


// ======================================
// Shared Equipment Helpers
// ======================================

function getOwnerEquipmentFilter(req) {
  const id = req.params.id;

  if (!/^[a-f0-9]{24}$/i.test(id)) {
    return null;
  }

  return {
    _id: new ObjectId(id),

    // Owner ID comes from verified JWT
    ownerId: req.authUser.id,
  };
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

// ======================================
// GET /equipment/mine/:id
// View One Owner Equipment
// ======================================

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
      const equipment = await db
        .collection("equipment")
        .findOne(filter);

      if (!equipment) {
        return res.status(404).json({
          error: "Equipment not found.",
        });
      }

      // Sanitize again before rendering as HTML
      const cleanDescription = cleanEquipmentDescription(
        equipment.descriptionHtml || ""
      );

      return res.status(200).json({
        success: true,
        equipment: {
          ...equipment,
          _id: equipment._id.toString(),
          descriptionHtml: cleanDescription,
          descriptionText: getPlainDescription(
            cleanDescription
          ),
        },
      });
    } catch (error) {
      console.error("Equipment details error:", error);

      return res.status(500).json({
        error: "Unable to load equipment details.",
      });
    }
  }
);

// ======================================
// PATCH /equipment/mine/:id
// Update Owner Equipment
// ======================================

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

    // Same validation rules as Add Equipment
    const valid =
      typeof name === "string" &&
      name.trim().length >= 3 &&
      name.trim().length <= 120 &&

      Array.isArray(categories) &&
      categories.length >= 1 &&
      categories.length <= allowedCategories.length &&
      categories.every((item) =>
        allowedCategories.includes(item)
      ) &&

      allowedConditions.includes(condition) &&

      Array.isArray(divisions) &&
      divisions.length >= 1 &&
      divisions.length <= allowedDivisions.length &&
      divisions.every((item) =>
        allowedDivisions.includes(item)
      ) &&

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

    const cleanDescription =
      cleanEquipmentDescription(descriptionHtml);

    const descriptionText =
      getPlainDescription(cleanDescription);

    if (
      descriptionText.length < 20 ||
      descriptionText.length > 3000
    ) {
      return res.status(400).json({
        error: "Description must contain 20–3000 characters.",
      });
    }

    try {
      const result = await db
        .collection("equipment")
        .updateOne(filter, {
          $set: {
            name: name.trim(),
            categories: [...new Set(categories)],
            condition,
            divisions: [...new Set(divisions)],
            descriptionHtml: cleanDescription,
            imageUrls: imageUrls.map((url) => url.trim()),
            dailyPrice,
            quantity,

            // Safe only while there are no active bookings
            availableQuantity: quantity,

            // Require fresh approval after changes
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
  }
);

// ======================================
// DELETE /equipment/mine/:id
// Delete Owner Equipment
// ======================================

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
      const result = await db
        .collection("equipment")
        .deleteOne(filter);

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
  }
);


startServer();
