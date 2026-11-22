
const SETTINGS_ID = "global";

const DEFAULT_SETTINGS = {
  platformName: "GearRento",
  supportEmail: "",
  supportPhone: "",
  announcementEnabled: false,
  announcementText: "",
  bookingsEnabled: true,
  maxRentalDays: 30,
};

// ======================================
// Read Settings from MongoDB
// ======================================

export async function getPlatformSettings(db) {
  const document = await db
    .collection("platformSettings")
    .findOne({ _id: SETTINGS_ID });

  if (!document) {
    return {
      ...DEFAULT_SETTINGS,
      updatedAt: null,
    };
  }

  return {
    platformName:
      document.platformName ??
      DEFAULT_SETTINGS.platformName,

    supportEmail:
      document.supportEmail ??
      DEFAULT_SETTINGS.supportEmail,

    supportPhone:
      document.supportPhone ??
      DEFAULT_SETTINGS.supportPhone,

    announcementEnabled:
      document.announcementEnabled ??
      DEFAULT_SETTINGS.announcementEnabled,

    announcementText:
      document.announcementText ??
      DEFAULT_SETTINGS.announcementText,

    bookingsEnabled:
      document.bookingsEnabled ??
      DEFAULT_SETTINGS.bookingsEnabled,

    maxRentalDays:
      document.maxRentalDays ??
      DEFAULT_SETTINGS.maxRentalDays,

    updatedAt: document.updatedAt || null,
  };
}

// ======================================
// Validate Admin Input
// ======================================

function validateSettings(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("Invalid settings data.");
  }

  const allowedFields = [
    "platformName",
    "supportEmail",
    "supportPhone",
    "announcementEnabled",
    "announcementText",
    "bookingsEnabled",
    "maxRentalDays",
  ];

  if (
    Object.keys(body).some(
      (key) => !allowedFields.includes(key)
    )
  ) {
    throw new Error(
      "Unsupported platform settings field."
    );
  }

  const {
    platformName,
    supportEmail,
    supportPhone,
    announcementEnabled,
    announcementText,
    bookingsEnabled,
    maxRentalDays,
  } = body;

  if (
    typeof platformName !== "string" ||
    platformName.trim().length < 2 ||
    platformName.trim().length > 60
  ) {
    throw new Error(
      "Platform name must contain 2 to 60 characters."
    );
  }

  if (
    typeof supportEmail !== "string" ||
    supportEmail.length > 254 ||
    (supportEmail.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        supportEmail.trim()
      ))
  ) {
    throw new Error(
      "Enter a valid support email address."
    );
  }

  if (
    typeof supportPhone !== "string" ||
    supportPhone.length > 30 ||
    (supportPhone.trim() &&
      !/^\+?[0-9][0-9\s()-]{5,28}$/.test(
        supportPhone.trim()
      ))
  ) {
    throw new Error(
      "Enter a valid support phone number."
    );
  }

  if (
    typeof announcementEnabled !== "boolean" ||
    typeof bookingsEnabled !== "boolean"
  ) {
    throw new Error(
      "Invalid enabled/disabled setting."
    );
  }

  if (
    typeof announcementText !== "string" ||
    announcementText.length > 280
  ) {
    throw new Error(
      "Announcement cannot exceed 280 characters."
    );
  }

  if (
    announcementEnabled &&
    !announcementText.trim()
  ) {
    throw new Error(
      "Enter an announcement before enabling it."
    );
  }

  if (
    !Number.isInteger(maxRentalDays) ||
    maxRentalDays < 1 ||
    maxRentalDays > 30
  ) {
    throw new Error(
      "Maximum rental days must be between 1 and 30."
    );
  }

  return {
    platformName: platformName.trim(),
    supportEmail: supportEmail.trim(),
    supportPhone: supportPhone.trim(),
    announcementEnabled,
    announcementText: announcementText.trim(),
    bookingsEnabled,
    maxRentalDays,
  };
}

// ======================================
// Register Settings Routes
// ======================================

export function registerPlatformSettingsRoutes(
  app,
  { getDb, verifyJWT, requireRole }
) {
  // ====================================
  // Public Settings
  // GET /platform-settings
  // ====================================

  app.get("/platform-settings", async (req, res) => {
    try {
      const settings = await getPlatformSettings(
        getDb()
      );

      res.set("Cache-Control", "no-store");

      return res.json({
        success: true,
        settings,
      });
    } catch (error) {
      console.error(
        "Public platform settings error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Unable to load platform settings.",
      });
    }
  });

  // ====================================
  // Admin Settings
  // GET /admin/platform-settings
  // ====================================

  app.get(
    "/admin/platform-settings",
    verifyJWT,
    requireRole("admin"),
    async (req, res) => {
      try {
        const settings = await getPlatformSettings(
          getDb()
        );

        const primaryAdminId =
          process.env.PRIMARY_ADMIN_ID?.trim();

        const canEdit = Boolean(
          primaryAdminId &&
          req.authUser.id === primaryAdminId
        );

        res.set("Cache-Control", "no-store");

        return res.json({
          success: true,
          settings,
          permissions: {
            canEdit,
          },
        });
      } catch (error) {
        console.error(
          "Admin settings error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to load settings.",
        });
      }
    }
  );

  // ====================================
  // Update Settings
  // PATCH /admin/platform-settings
  // Main Admin Only
  // ====================================

  app.patch(
    "/admin/platform-settings",
    verifyJWT,
    requireRole("admin"),
    async (req, res) => {
      try {
        const primaryAdminId =
          process.env.PRIMARY_ADMIN_ID?.trim();

        if (
          !primaryAdminId ||
          req.authUser.id !== primaryAdminId
        ) {
          return res.status(403).json({
            success: false,
            error:
              "Only the Main Admin can update platform settings.",
          });
        }

        // Check the current role in MongoDB.
        const idCandidates = [primaryAdminId];

        const { ObjectId } = await import("mongodb");

        if (/^[a-f0-9]{24}$/i.test(primaryAdminId)) {
          idCandidates.push(
            new ObjectId(primaryAdminId)
          );
        }

        const currentAdmin = await getDb()
          .collection("user")
          .findOne(
            {
              _id: {
                $in: idCandidates,
              },
              role: "admin",
            },
            {
              projection: { _id: 1 },
            }
          );

        if (!currentAdmin) {
          return res.status(403).json({
            success: false,
            error: "Main Admin access required.",
          });
        }

        let values;

        try {
          values = validateSettings(req.body);
        } catch (error) {
          return res.status(400).json({
            success: false,
            error: error.message,
          });
        }

        const db = getDb();
        const now = new Date();

        await db
          .collection("platformSettings")
          .updateOne(
            { _id: SETTINGS_ID },
            {
              $set: {
                ...values,
                updatedBy: req.authUser.id,
                updatedAt: now,
              },
            },
            {
              upsert: true,
            }
          );

        const settings =
          await getPlatformSettings(db);

        console.info("Platform settings updated", {
          adminId: req.authUser.id,
          updatedAt: now.toISOString(),
        });

        return res.json({
          success: true,
          message:
            "Platform settings saved successfully.",
          settings,
        });
      } catch (error) {
        console.error(
          "Update platform settings error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to save platform settings.",
        });
      }
    }
  );
}
