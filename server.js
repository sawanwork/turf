require("dotenv").config();
const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const Razorpay = require("razorpay");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: "turf.sid",
  secret: process.env.SESSION_SECRET || "replace-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  timezone: "Z"
});

const defaults = {
  phoneVerificationEnabled: false,
  paymentGatewayEnabled: false,
  businessName: "CC Turf Booking",
  currency: "INR",
  bookingHoldMinutes: 10,
  bookingAdvancePercent: 100,
  demoPaymentLabel: "Demo Payment (Testing Only)"
};

async function initDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(100) PRIMARY KEY, setting_value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NULL, phone VARCHAR(20) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS turfs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, area VARCHAR(160) NOT NULL, address TEXT NULL, description TEXT NULL, image_url TEXT NULL, sports VARCHAR(255) DEFAULT 'Cricket', price_per_hour DECIMAL(10,2) NOT NULL DEFAULT 500, rating DECIMAL(3,2) DEFAULT 4.8, review_count INT DEFAULT 0, open_time TIME DEFAULT '06:00:00', close_time TIME DEFAULT '23:00:00', active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS bookings (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, booking_code VARCHAR(30) NOT NULL UNIQUE, user_id BIGINT UNSIGNED NOT NULL, turf_id BIGINT UNSIGNED NOT NULL, booking_date DATE NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL, hours DECIMAL(5,2) NOT NULL, total_amount DECIMAL(10,2) NOT NULL, payment_status ENUM('pending','paid','failed','refunded') NOT NULL DEFAULT 'pending', booking_status ENUM('pending_payment','confirmed','cancelled','expired') NOT NULL DEFAULT 'pending_payment', payment_provider VARCHAR(30) NOT NULL DEFAULT 'demo', payment_reference VARCHAR(150) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_turf_date (turf_id, booking_date), INDEX idx_user (user_id), CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id), CONSTRAINT fk_booking_turf FOREIGN KEY (turf_id) REFERENCES turfs(id))`,
    `CREATE TABLE IF NOT EXISTS payments (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, booking_id BIGINT UNSIGNED NOT NULL, provider VARCHAR(30) NOT NULL, provider_order_id VARCHAR(150) NULL, provider_payment_id VARCHAR(150) NULL, amount DECIMAL(10,2) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'created', payload JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_payment_booking (booking_id), CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings(id))`
  ];
  for (const s of statements) await pool.query(s);
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?,?)", [key, String(value)]);
  }
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM turfs");
  if (!rows[0].n) {
    await pool.query(
      `INSERT INTO turfs (name,area,address,description,image_url,sports,price_per_hour,rating,review_count) VALUES
      (?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?)`,
      [
        "City Cricket Arena","Ram Nagar","Add full turf address in Admin Settings","Well-maintained cricket turf for friends, teams and practice sessions.","https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&w=1200&q=80","Cricket",800,4.8,124,
        "Greenfield Sports Turf","Wardha Road","Add full turf address in Admin Settings","Book a convenient slot for your next game.","https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80","Cricket,Football",650,4.6,86
      ]
    );
  }
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const phone = "admin:" + process.env.ADMIN_USERNAME;
    const [found] = await pool.query("SELECT id FROM users WHERE phone=?", [phone]);
    if (!found.length) {
      // Admin credentials are handled separately; this row is not a customer login.
    }
  }
}
async function getSettings() {
  const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings");
  const out = { ...defaults };
  for (const r of rows) {
    let v = r.setting_value;
    if (["phoneVerificationEnabled","paymentGatewayEnabled"].includes(r.setting_key)) v = v === "true";
    if (["bookingHoldMinutes","bookingAdvancePercent"].includes(r.setting_key)) v = Number(v);
    out[r.setting_key] = v;
  }
  return out;
}
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const isAdmin = (req,res,next) => req.session.admin ? next() : res.status(401).json({error:"Admin login required."});
const isUser = (req,res,next) => req.session.user ? next() : res.status(401).json({error:"Please enter your mobile number first."});
const razorpayClient = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error("Razorpay keys are not configured in the server environment.");
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
};
function makeBookingCode() { return "TB" + Date.now().toString().slice(-8) + crypto.randomBytes(2).toString("hex").toUpperCase(); }

app.get("/api/public-config", asyncRoute(async (req,res) => {
  const s = await getSettings();
  res.json({businessName:s.businessName, phoneVerificationEnabled:s.phoneVerificationEnabled, paymentGatewayEnabled:s.paymentGatewayEnabled, currency:s.currency});
}));

app.post("/api/login", asyncRoute(async (req,res) => {
  const phone = String(req.body.phone || "").replace(/[^\d+]/g,"").trim();
  const name = String(req.body.name || "").trim().slice(0,120);
  if (!/^\+?[0-9]{10,15}$/.test(phone)) return res.status(400).json({error:"Enter a valid mobile number (10–15 digits)."});
  const s = await getSettings();
  if (s.phoneVerificationEnabled) {
    return res.status(503).json({error:"Phone verification is enabled but no OTP provider is connected yet. Configure the provider before turning this on for customers."});
  }
  await pool.query("INSERT INTO users (phone,name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=IF(VALUES(name) IS NULL OR VALUES(name)='', name, VALUES(name))", [phone,name || null]);
  const [rows] = await pool.query("SELECT id,phone,name FROM users WHERE phone=?", [phone]);
  req.session.user = {id:rows[0].id,phone:rows[0].phone,name:rows[0].name};
  res.json({ok:true,user:req.session.user});
}));
app.post("/api/logout", (req,res) => req.session.destroy(() => res.json({ok:true})));
app.get("/api/me", (req,res) => res.json({user:req.session.user || null}));
app.get("/api/turfs", asyncRoute(async (req,res) => {
  const [rows] = await pool.query("SELECT id,name,area,address,description,image_url,sports,price_per_hour,rating,review_count FROM turfs WHERE active=1 ORDER BY id DESC");
  res.json(rows);
}));
app.get("/api/turfs/:id", asyncRoute(async (req,res) => {
  const [rows] = await pool.query("SELECT id,name,area,address,description,image_url,sports,price_per_hour,rating,review_count,open_time,close_time FROM turfs WHERE id=? AND active=1", [req.params.id]);
  if (!rows.length) return res.status(404).json({error:"Turf not found."});
  res.json(rows[0]);
}));
app.get("/api/availability", asyncRoute(async (req,res) => {
  const {turfId,date} = req.query;
  if (!turfId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"Turf and date are required."});
  const [turfRows] = await pool.query("SELECT open_time,close_time FROM turfs WHERE id=? AND active=1", [turfId]);
  if (!turfRows.length) return res.status(404).json({error:"Turf not found."});
  const [bookings] = await pool.query("SELECT start_time,end_time,booking_status,created_at FROM bookings WHERE turf_id=? AND booking_date=? AND booking_status IN ('confirmed','pending_payment')", [turfId,date]);
  const booked = [];
  const start = Number(String(turfRows[0].open_time).slice(0,2));
  const end = Number(String(turfRows[0].close_time).slice(0,2));
  for (let h=start; h<end; h++) {
    const hh = String(h).padStart(2,"0")+":00:00";
    const next = String(h+1).padStart(2,"0")+":00:00";
    const taken = bookings.some(b => {
      if (b.booking_status === "pending_payment" && Date.now() - new Date(b.created_at).getTime() > 10*60*1000) return false;
      return String(b.start_time).slice(0,8) < next && String(b.end_time).slice(0,8) > hh;
    });
    booked.push({start:hh.slice(0,5),end:next.slice(0,5),available:!taken});
  }
  res.json(booked);
}));
app.post("/api/bookings", isUser, asyncRoute(async (req,res) => {
  const turfId = Number(req.body.turfId), date = String(req.body.date || ""), slots = Array.isArray(req.body.slots) ? req.body.slots : [];
  if (!turfId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !slots.length) return res.status(400).json({error:"Select a date and at least one time slot."});
  const sorted = [...new Set(slots.map(String))].sort();
  if (sorted.some(t => !/^\d{2}:\d{2}$/.test(t))) return res.status(400).json({error:"Invalid slot selection."});
  for (let i=1;i<sorted.length;i++) if (Number(sorted[i].slice(0,2)) !== Number(sorted[i-1].slice(0,2))+1) return res.status(400).json({error:"Please select consecutive slots for one booking."});
  if (date < new Date().toISOString().slice(0,10)) return res.status(400).json({error:"Past dates cannot be booked."});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [turfRows] = await conn.query("SELECT * FROM turfs WHERE id=? AND active=1 FOR UPDATE", [turfId]);
    if (!turfRows.length) throw new Error("Turf not found.");
    const turf = turfRows[0];
    const start = sorted[0] + ":00";
    const lastHour = Number(sorted[sorted.length-1].slice(0,2))+1;
    const end = String(lastHour).padStart(2,"0")+":00:00";
    const [conflicts] = await conn.query("SELECT id FROM bookings WHERE turf_id=? AND booking_date=? AND booking_status IN ('confirmed','pending_payment') AND start_time < ? AND end_time > ? FOR UPDATE", [turfId,date,end,start]);
    if (conflicts.length) throw new Error("One or more selected slots are no longer available. Please refresh and select again.");
    const hours = sorted.length, total = Number(turf.price_per_hour) * hours, code = makeBookingCode();
    const [result] = await conn.query("INSERT INTO bookings (booking_code,user_id,turf_id,booking_date,start_time,end_time,hours,total_amount,payment_status,booking_status,payment_provider) VALUES (?,?,?,?,?,?,?,?, 'pending','pending_payment','demo')", [code,req.session.user.id,turfId,date,start,end,hours,total]);
    await conn.query("INSERT INTO payments (booking_id,provider,amount,status) VALUES (?,'demo',?,'created')", [result.insertId,total]);
    await conn.commit();
    res.json({ok:true,bookingId:result.insertId,bookingCode:code,totalAmount:total,currency:"INR",date,startTime:start.slice(0,5),endTime:end.slice(0,5),turfName:turf.name});
  } catch(e) {
    await conn.rollback();
    res.status(400).json({error:e.message || "Could not create booking."});
  } finally { conn.release(); }
}));
app.post("/api/payments/demo/:bookingId", isUser, asyncRoute(async (req,res) => {
  const id = Number(req.params.bookingId);
  const [rows] = await pool.query("SELECT * FROM bookings WHERE id=? AND user_id=?", [id,req.session.user.id]);
  if (!rows.length) return res.status(404).json({error:"Booking not found."});
  const b=rows[0];
  if (b.payment_status === "paid") return res.json({ok:true,bookingCode:b.booking_code,message:"Payment already recorded."});
  // This demo endpoint simulates a successful payment; it is not a real transaction.
  await pool.query("UPDATE bookings SET payment_status='paid',booking_status='confirmed',payment_provider='demo',payment_reference=? WHERE id=?", ["DEMO-"+crypto.randomBytes(5).toString("hex").toUpperCase(),id]);
  await pool.query("UPDATE payments SET status='succeeded',provider_payment_id=? WHERE booking_id=? ORDER BY id DESC LIMIT 1", ["DEMO-"+crypto.randomBytes(5).toString("hex").toUpperCase(),id]);
  res.json({ok:true,bookingCode:b.booking_code,message:"Demo payment successful. No money was charged."});
}));
app.post("/api/payments/razorpay/order/:bookingId", isUser, asyncRoute(async (req,res) => {
  const s=await getSettings();
  if (!s.paymentGatewayEnabled) return res.status(403).json({error:"Online payment gateway is disabled."});
  const id=Number(req.params.bookingId);
  const [rows]=await pool.query("SELECT * FROM bookings WHERE id=? AND user_id=? AND booking_status='pending_payment'",[id,req.session.user.id]);
  if (!rows.length) return res.status(404).json({error:"Pending booking not found."});
  const b=rows[0];
  const order=await razorpayClient().orders.create({amount:Math.round(Number(b.total_amount)*100),currency:"INR",receipt:b.booking_code,notes:{bookingCode:b.booking_code}});
  await pool.query("UPDATE bookings SET payment_provider='razorpay',payment_reference=? WHERE id=?",[order.id,id]);
  await pool.query("INSERT INTO payments (booking_id,provider,provider_order_id,amount,status) VALUES (?,'razorpay',?,?,'created')",[id,order.id,b.total_amount]);
  res.json({keyId:process.env.RAZORPAY_KEY_ID,orderId:order.id,amount:order.amount,currency:order.currency,bookingCode:b.booking_code});
}));
app.post("/api/payments/razorpay/verify", isUser, asyncRoute(async (req,res) => {
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature,bookingId}=req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({error:"Payment response is incomplete."});
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+"|"+razorpay_payment_id).digest("hex");
  if (expected !== razorpay_signature) return res.status(400).json({error:"Payment signature verification failed."});
  const [rows]=await pool.query("SELECT * FROM bookings WHERE id=? AND user_id=? AND payment_reference=?",[bookingId,req.session.user.id,razorpay_order_id]);
  if (!rows.length) return res.status(404).json({error:"Booking does not match this payment."});
  await pool.query("UPDATE bookings SET payment_status='paid',booking_status='confirmed',payment_provider='razorpay' WHERE id=?",[bookingId]);
  await pool.query("UPDATE payments SET status='succeeded',provider_payment_id=?,payload=? WHERE booking_id=? AND provider_order_id=?",[razorpay_payment_id,JSON.stringify({razorpay_payment_id}),bookingId,razorpay_order_id]);
  res.json({ok:true,bookingCode:rows[0].booking_code});
}));
app.get("/api/my-bookings", isUser, asyncRoute(async (req,res) => {
  const [rows]=await pool.query(`SELECT b.id,b.booking_code,b.booking_date,b.start_time,b.end_time,b.total_amount,b.payment_status,b.booking_status,t.name AS turf_name,t.area FROM bookings b JOIN turfs t ON t.id=b.turf_id WHERE b.user_id=? ORDER BY b.created_at DESC`,[req.session.user.id]);
  res.json(rows);
}));

// Admin authentication and dashboard APIs
app.post("/api/admin/login", asyncRoute(async (req,res) => {
  const username=String(req.body.username||"");
  const password=String(req.body.password||"");
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || username !== process.env.ADMIN_USERNAME || !bcrypt.compareSync(password, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10))) {
    // Constant-time comparison is not required for this MVP, but use generic error messages.
    if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({error:"Invalid admin credentials."});
  }
  req.session.admin={username};
  res.json({ok:true});
}));
app.post("/api/admin/logout",(req,res)=>{req.session.admin=null;res.json({ok:true});});
app.get("/api/admin/me",(req,res)=>res.json({admin:req.session.admin||null}));
app.get("/api/admin/settings",isAdmin,asyncRoute(async(req,res)=>res.json(await getSettings())));
app.put("/api/admin/settings",isAdmin,asyncRoute(async(req,res)=>{
  const allowed=["phoneVerificationEnabled","paymentGatewayEnabled","businessName","bookingHoldMinutes","bookingAdvancePercent"];
  for(const key of allowed) if(req.body[key]!==undefined) await pool.query("INSERT INTO settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[key,String(req.body[key])]);
  const s=await getSettings();
  if(s.paymentGatewayEnabled && (!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)) {
    // Do not silently activate a broken live checkout.
    await pool.query("UPDATE settings SET setting_value='false' WHERE setting_key='paymentGatewayEnabled'");
    return res.status(400).json({error:"Add Razorpay API keys to the server environment before enabling the gateway."});
  }
  if(s.phoneVerificationEnabled) {
    await pool.query("UPDATE settings SET setting_value='false' WHERE setting_key='phoneVerificationEnabled'");
    return res.status(400).json({error:"OTP provider is not connected yet. Add the provider integration before enabling phone verification."});
  }
  res.json(await getSettings());
}));
app.get("/api/admin/summary",isAdmin,asyncRoute(async(req,res)=>{
  const [[counts]]=await pool.query(`SELECT COUNT(*) totalBookings, SUM(booking_status='confirmed') confirmedBookings, SUM(payment_status='paid') paidBookings, COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_amount ELSE 0 END),0) revenue FROM bookings`);
  const [recent]=await pool.query(`SELECT b.id,b.booking_code,b.booking_date,b.start_time,b.end_time,b.total_amount,b.payment_status,b.booking_status,u.phone,t.name turf_name FROM bookings b JOIN users u ON u.id=b.user_id JOIN turfs t ON t.id=b.turf_id ORDER BY b.created_at DESC LIMIT 100`);
  res.json({counts,recent});
}));
app.get("/api/admin/turfs",isAdmin,asyncRoute(async(req,res)=>{const [rows]=await pool.query("SELECT * FROM turfs ORDER BY id DESC");res.json(rows);}));
app.post("/api/admin/turfs",isAdmin,asyncRoute(async(req,res)=>{
  const d=req.body;
  if(!String(d.name||"").trim()||!String(d.area||"").trim()||!Number(d.price_per_hour))return res.status(400).json({error:"Name, area and hourly price are required."});
  const [r]=await pool.query("INSERT INTO turfs (name,area,address,description,image_url,sports,price_per_hour,rating,review_count,active) VALUES (?,?,?,?,?,?,?,?,?,?)",[d.name,d.area,d.address||"",d.description||"",d.image_url||"",d.sports||"Cricket",Number(d.price_per_hour),Number(d.rating||4.8),Number(d.review_count||0),d.active===false?0:1]);
  res.json({ok:true,id:r.insertId});
}));
app.put("/api/admin/turfs/:id",isAdmin,asyncRoute(async(req,res)=>{
  const d=req.body;
  await pool.query("UPDATE turfs SET name=?,area=?,address=?,description=?,image_url=?,sports=?,price_per_hour=?,active=? WHERE id=?",[d.name,d.area,d.address||"",d.description||"",d.image_url||"",d.sports||"Cricket",Number(d.price_per_hour),d.active?1:0,req.params.id]);
  res.json({ok:true});
}));
app.patch("/api/admin/bookings/:id",isAdmin,asyncRoute(async(req,res)=>{
  const status=String(req.body.status||"");
  if(!["confirmed","cancelled","expired"].includes(status))return res.status(400).json({error:"Invalid booking status."});
  await pool.query("UPDATE bookings SET booking_status=? WHERE id=?",[status,req.params.id]);
  res.json({ok:true});
}));
app.get("/api/admin/users",isAdmin,asyncRoute(async(req,res)=>{const [rows]=await pool.query("SELECT id,name,phone,created_at FROM users WHERE phone NOT LIKE 'admin:%' ORDER BY created_at DESC LIMIT 500");res.json(rows);}));

app.get("/admin", (req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error: process.env.NODE_ENV === "production" ? "Something went wrong. Please try again." : err.message});
});

const port=Number(process.env.PORT||3000);
initDb().then(()=>app.listen(port,()=>console.log(`Turf booking app running on port ${port}`))).catch(err=>{console.error("Database initialization failed:",err);process.exit(1);});
