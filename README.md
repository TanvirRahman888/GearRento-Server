# GearRento Backend

**REST API for the GearRento equipment rental marketplace**

GearRento connects equipment owners and renters across Bangladesh. This backend powers equipment listings and approvals, role-based access, booking workflows, rental history, availability management, and featured equipment functionality.

> **Documentation scope:** This README is based on the Express application code shared for the project. Some features are implemented in imported modules; their exact routes are not listed unless confirmed in the shared entry-point code.

## Tech stack

- **Runtime:** Node.js (ES modules)
- **Framework:** Express.js
- **Database:** MongoDB (MongoDB Node.js driver)
- **Authentication:** Better Auth-issued JWTs, verified using JWKS and `jose`
- **Payments:** Stripe integration (booking and webhook module)
- **Security and middleware:** CORS, HTML sanitization (`sanitize-html`), JSON request parsing, role authorization
- **Deployment target:** Vercel (Express)

## Core features

- Public browsing of **approved** rental equipment
- Search and filtering by name, category, division, condition, and price range
- Rental listings with photos, daily pricing, stock quantities, and location divisions
- Owner-only equipment submission and management
- Administrator approval/rejection workflow
- Role-based authorization (`customer`, `owner`, `admin`)
- Better Auth JWT signature and claim validation against remote JWKS
- Booking and Stripe webhook functionality in dedicated modules
- Equipment availability, customer rental history, and featured listing modules

## Project structure

The backend entry point imports modules similar to the following:

```text
gearrento-backend/
├── index.js                        # Express entry point (rename if your actual file differs)
├── stripe-bookings.js              # Stripe webhook and booking routes
├── admin-users.js                  # Administrator user operations
├── admin-equipment.js              # Administrator equipment operations
├── platform-settings.js           # Platform settings operations
├── owner-availability.js          # Owner availability operations
├── customer-rental-history.js     # Customer rental history operations
├── featured-equipment.js          # Featured listing operations
├── package.json
├── vercel.json
├── .env                            # Local secrets — do not commit
└── .gitignore
```

## Prerequisites

- Node.js and npm (use a maintained Node.js LTS release)
- A MongoDB database, such as MongoDB Atlas
- A running GearRento Next.js frontend with Better Auth configured
- Stripe credentials **if** using the payment/booking features

## Getting started locally

1. Clone your backend repository and enter its directory:

   ```bash
   git clone <your-backend-repository-url>
   cd gearrento-backend
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Add a `.env` file using the example below.

4. Ensure `package.json` has a script for your actual entry point. For example, if the entry point is `index.js`:

   ```json
   {
     "type": "module",
     "scripts": {
       "dev": "node --watch index.js",
       "start": "node index.js"
     }
   }
   ```

   Add or merge the example fields into your existing `package.json`; **do not replace its dependencies**.

5. Start the API:

   ```bash
   npm run dev
   ```

   Or use `npm start` if that is the script configured in your project.

6. Visit `http://localhost:5000/` to test the health-check route.

## Environment variables

Create `.env` in the backend project root:

```dotenv
# Backend HTTP port (used for local development)
PORT=5000

# Next.js / Better Auth origin
CLIENT_URL=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000

# Database
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority
DB_NAME=GearRento

# Stripe (only if required by your Stripe modules)
STRIPE_SECRET_KEY=<your-stripe-secret-key>
STRIPE_WEBHOOK_SECRET=<your-stripe-webhook-signing-secret>
```

| Variable | Purpose | Required by shared entry point |
| --- | --- | --- |
| `CLIENT_URL` | Allowed browser origin in CORS | Yes |
| `BETTER_AUTH_URL` | Better Auth issuer/audience and JWKS base URL | Yes |
| `MONGODB_URI` | MongoDB connection string | Yes |
| `DB_NAME` | Database name (defaults to `GearRento`) | No |
| `PORT` | Local HTTP port (defaults to `5000`) | No |
| Stripe variables | Payment/webhook configuration | Check `stripe-bookings.js` |

**Security:** Never commit `.env` files, database credentials, Stripe keys, or JWTs. Configure real credentials in the deployment provider's environment-variable settings. The Better Auth signing secret is configured in the **frontend/auth application**; this backend verifies issued JWTs against the public JWKS endpoint rather than requiring the signing secret.

## API overview

**Base URL (local):** `http://localhost:5000`

### Health check

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | Public | API health response |

Example response:

```json
{
  "success": true,
  "message": "GearRento API is running"
}
```

### Equipment endpoints

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/equipment` | Public | List approved equipment with search, filters and sorting |
| `GET` | `/equipment/:id` | Public **in the shared backend code** | Get details of an approved listing |
| `POST` | `/equipment/add` | Owner | Submit a new equipment listing for review |
| `GET` | `/equipment/mine` | Owner | Paginated list of the owner's equipment |
| `GET` | `/equipment/mine/:id` | Owner | Get one owned listing |
| `PATCH` | `/equipment/mine/:id` | Owner | Update an owned listing (resubmits for approval) |
| `DELETE` | `/equipment/mine/:id` | Owner | Delete an owned listing |
| `GET` | `/equipment/pending` | Admin | List pending equipment |
| `PATCH` | `/equipment/review/:id` | Admin | Approve or reject pending equipment |

### Public listing filters

`GET /equipment` accepts the following query parameters:

| Parameter | Example | Description |
| --- | --- | --- |
| `q` | `camera` | Case-insensitive name search |
| `category` | `Photography` | Match equipment category |
| `division` | `Dhaka` | Match Bangladesh division |
| `condition` | `new` | Filter by equipment condition |
| `minPrice` | `500` | Minimum daily rental price |
| `maxPrice` | `3000` | Maximum daily rental price |
| `sort` | `price-low` | Price ascending |
| `sort` | `price-high` | Price descending |
| `sort` | `oldest` | Oldest listings first |
| `page` | `1` | Page number (12 listings per page) |

By default, the shared route sorts **currently featured** approved listings first and then by newest creation date. A `sort=newest` option was proposed during homepage development; document or use it only after confirming that change is present in your backend.

**Example requests:**

```http
GET /equipment?q=camera&division=Dhaka
GET /equipment?category=Power%20Tools&sort=price-low
GET /equipment?sort=price-high&page=1
GET /equipment?minPrice=500&maxPrice=2000
```

The listing response includes an `equipment` array and pagination metadata (`page`, `limit`, `total`, `totalPages`). MongoDB `_id` values are returned as strings.

### Listing data model (selected fields)

```json
{
  "_id": "<mongodb-object-id>",
  "name": "Camera kit",
  "categories": ["Photography"],
  "condition": "new",
  "divisions": ["Dhaka"],
  "descriptionHtml": "<p>Equipment details...</p>",
  "imageUrls": ["https://example.com/equipment.jpg"],
  "dailyPrice": 850,
  "quantity": 3,
  "availableQuantity": 3,
  "ownerId": "<owner-user-id>",
  "status": "pending"
}
```

This is an **illustrative listing**, not a live record. The public equipment-list endpoint returns a subset of fields and does not expose all owner/admin fields.

Newly submitted listings start as `pending`; an administrator can change their status to `approved` or `rejected`. Only `approved` listings are exposed through the public equipment APIs.

### Additional backend modules

The Express entry point also registers handlers from:

- `stripe-bookings.js` — Stripe webhook and rental booking endpoints
- `admin-users.js` — admin user management
- `admin-equipment.js` — admin equipment management
- `platform-settings.js` — platform configuration
- `owner-availability.js` — availability management
- `customer-rental-history.js` — customer rental history
- `featured-equipment.js` — featured equipment management

For exact HTTP methods, paths, request bodies, and authorization rules, see the corresponding module source files. The module contents were not included in the shared entry-point snippet, so this README intentionally does not invent their route names.

## Authentication and authorization

The backend expects an access token issued by Better Auth in the `Authorization` header for protected routes:

```http
Authorization: Bearer <better-auth-jwt>
```

The shared `verifyJWT` middleware:

1. Reads the Bearer token.
2. Loads public signing keys from `${BETTER_AUTH_URL}/api/auth/jwks`.
3. Verifies the token signature, issuer, audience, expiry, and expected algorithm (`EdDSA`).
4. Requires a valid subject (`sub`) and supported role (`customer`, `owner`, or `admin`).
5. Looks up the user in MongoDB and rejects a token if the current stored role does not match its role claim.

`requireRole(...)` then restricts owner- and administrator-only routes.

> **Access-control note:** Protecting `/equipment/[id]` in the Next.js frontend does **not** protect `GET /equipment/:id` on the Express API. In the backend code shared so far, that API endpoint is public for approved listings. Add backend authorization if the API data itself should be private.

## Payments and webhooks

Stripe payment and booking handlers are registered from `stripe-bookings.js`.

- Configure the Stripe secrets required by that module.
- Set your Stripe webhook endpoint to the **actual path registered inside `stripe-bookings.js`**.
- Keep the webhook's raw-body middleware **before** `express.json()` so Stripe signature verification can use the unmodified request body.
- Use Stripe test credentials when testing; switch to production credentials only for live payments.
- Verify the payment, booking, and webhook flows in your deployed environment.

## Database notes

The backend uses the MongoDB Node.js driver and a database named `GearRento` by default. Startup code creates indexes for several collections, including equipment, bookings, owner requests, equipment features, and administrative audit logs.

Use one reusable database connection per runtime instance when deploying to a serverless environment rather than opening a new connection for every request.

## Deploying to Vercel

Vercel supports Express apps directly using a recognized entry file (`index.js`, `server.js`, or `src/index.js`, among others). An Express app can be exported or started using a port listener. See [Vercel's Express documentation](https://vercel.com/docs/frameworks/backend/express).

A minimal optional `vercel.json` is:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "express"
}
```

### Deployment checklist

1. Push the backend project to a Git repository (without `.env`).
2. Import the backend project into Vercel, selecting the correct root directory and Express framework if needed.
3. Configure production environment variables: `CLIENT_URL`, `BETTER_AUTH_URL`, `MONGODB_URI`, `DB_NAME`, and the payment variables required by your modules.
4. Make sure `CLIENT_URL` matches the deployed frontend origin exactly so CORS permits browser requests.
5. Make sure the frontend Better Auth JWKS endpoint is reachable from the backend.
6. Review asynchronous database initialization and route registration before deploying; requests must not arrive before required setup is ready.
7. Confirm the MongoDB Atlas network policy allows the deployed runtime to connect.
8. Deploy, then test `/` and `/equipment`, authentication-required routes, and Stripe test webhooks.
9. Point the frontend's API base URL at the deployed backend and redeploy the frontend if necessary.

**Important:** Vercel runs your Express service as a function. Code that assumes a permanently running server, such as long-lived background processes, must be reviewed for that runtime model.

## Common problems

| Problem | What to check |
| --- | --- |
| CORS errors | `CLIENT_URL` must equal the requesting frontend origin (including scheme and port). |
| `401` on protected routes | Check Bearer JWT, expiration, frontend Better Auth JWKS URL, issuer/audience, and user record. |
| `403` on protected routes | Check user role, JWT role claim, and stored database role. |
| MongoDB connection errors | Check `MONGODB_URI`, Atlas network access, and credentials. |
| No products returned | Public listing only includes `status: "approved"` records; check filters and pagination. |
| Invalid Stripe webhook signature | Verify webhook secret and ensure the raw body is used before JSON parsing. |
| Vercel deployment responds unexpectedly | Confirm Express entry point, startup initialization, and deployment environment variables. |

## Security checklist

- Keep `.env`, JWTs, signing secrets, MongoDB credentials, and Stripe secrets private.
- Require Better Auth JWT verification and role checks for protected API operations.
- Validate incoming equipment data and sanitize accepted HTML.
- Verify Stripe webhook signatures.
- Keep CORS restricted to trusted frontend origins.
- Enforce authorization on the **backend**, not only via Next.js route protection.
- Test all owner/admin endpoints using tokens from different user roles.

## License

License information has not been specified. Add your chosen license and a `LICENSE` file before distributing this backend publicly, if appropriate.
