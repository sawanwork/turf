# Turf Booking Web App (Node.js + MySQL)

A mobile-first starter application for Hostinger Node.js hosting. Includes turf listings, mobile-number login (OTP disabled initially), slot availability, booking creation, demo checkout, Razorpay integration scaffold, and an admin dashboard.

## Important limitations
- **Demo payment is not a real payment method.** It simulates success and must only be used in testing. Do not launch publicly with demo checkout presented as real payment.
- Phone OTP is intentionally **disabled**. The admin toggle remains visible but locked until a real OTP provider is integrated. Enabling it before implementing the provider would block login.
- Razorpay is disabled by default. The admin toggle only works when server environment keys exist. Before accepting real payments, test order creation, signature verification, webhooks/reconciliation, refunds, failure cases, and booking expiry.
- This is an MVP foundation, not yet a production-audited booking platform. Before launch, add a persistent production session store, CSRF protection, stronger admin user management/MFA, cleanup job for expired pending bookings, transactional slot-locking review, Razorpay webhooks, backups, logging, privacy/terms, and end-to-end testing.
- Uses MySQL, which is suitable for Hostinger MySQL hosting. Avoid JSON-file storage for production booking data.

## Local setup
1. Install Node.js 20+ and MySQL.
2. Create a database and database user.
3. Copy `.env.example` to `.env` and fill database values, a strong `SESSION_SECRET`, and strong admin credentials.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000` and `/admin`.

The server creates the required tables and two sample turfs on first run.

## Hostinger deployment
1. Create a MySQL database and user in hPanel.
2. Upload this folder to a Node.js application directory (or connect a Git repository).
3. Set the Node.js application entry file to `server.js` and use a supported Node.js version (20+).
4. Add the environment variables from `.env.example` in hPanel. Use the exact DB host/name/user/password shown in hPanel.
5. Install dependencies using `npm install` (or Hostinger's deployment workflow), then start/restart the application.
6. Connect the domain/subdomain to the Node.js application and enable HTTPS.
7. Visit `/admin`, sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`, then edit the sample turfs.
8. Keep `PAYMENT_GATEWAY_ENABLED=false` until Razorpay keys and live payment flow are tested.
9. Keep `PHONE_VERIFICATION_ENABLED=false` until the WhatsApp/SMS OTP provider integration has been completed and tested.

## Admin settings
- **Phone OTP verification:** deliberately locked in the UI until a provider is integrated. The backend refuses activation rather than accidentally locking all customers out.
- **Razorpay:** disabled by default. Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in the server environment before enabling it.
- Demo checkout is the only checkout available while the gateway is disabled. It must be removed or hidden before a public production launch.

## Booking flow
Mobile number login → choose turf → select date and consecutive hourly slots → create pending booking → demo payment or Razorpay checkout → booking confirmation.
