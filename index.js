require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Firebase Admin Initialization
const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

// Stripe Initialization (safe)
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
} else {
  console.error("STRIPE_SECRET_KEY is missing!");
}

// Dynamic Cookie Options
const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "none",
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

// CORS Configuration
app.use(
  cors({
    origin: ["http://localhost:5173", "https://local-chef-bazar.netlify.app"],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// MongoDB Connection
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const usersCollection = client.db("localchefbazaar").collection("users");
    const mealsCollection = client.db("localchefbazaar").collection("meals");
    const reviewsCollection = client
      .db("localchefbazaar")
      .collection("reviews");
    const favoritesCollection = client
      .db("localchefbazaar")
      .collection("favorites");
    const ordersCollection = client.db("localchefbazaar").collection("orders");
    const requestsCollection = client
      .db("localchefbazaar")
      .collection("requests");

    // JWT Middleware
    const verifyToken = (req, res, next) => {
      const token = req.cookies?.token;
      if (!token) return res.status(401).send({ message: "Unauthorized" });

      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: "Invalid token" });
        req.decoded = decoded;
        next();
      });
    };

    // Exchange Firebase token for JWT
    app.post("/jwt", async (req, res) => {
      const { idToken } = req.body;
      if (!idToken) return res.status(400).send({ success: false });

      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const token = jwt.sign(
          { email: decodedToken.email },
          process.env.JWT_SECRET,
          { expiresIn: "30d" }
        );
        res.cookie("token", token, cookieOptions);
        res.send({ success: true });
      } catch (error) {
        console.error("Firebase token error:", error.message);
        res.status(401).send({ success: false });
      }
    });

    // Logout
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
      });
      res.send({ success: true });
    });

    // Sync or create user
    app.put("/users", verifyToken, async (req, res) => {
      const userData = req.body;
      const result = await usersCollection.updateOne(
        { email: userData.email },
        {
          $set: { ...userData, updatedAt: new Date() },
          $setOnInsert: {
            role: "user",
            status: "active",
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
      const finalUser = await usersCollection.findOne({
        email: userData.email,
      });
      res.send({ user: finalUser });
    });

    // Get user by email
    app.get("/user/:email", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send(user);
    });

    // Get user role
    app.get("/user/role/:email", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || "user" });
    });

    // Meals endpoints
    app.get("/meals", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";
      const sort = req.query.sort;

      let query = {};
      if (search) query.foodName = { $regex: search, $options: "i" };

      let sortObj = {};
      if (sort === "asc") sortObj.price = 1;
      if (sort === "desc") sortObj.price = -1;

      const meals = await mealsCollection
        .find(query)
        .sort(sortObj)
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

      const total = await mealsCollection.countDocuments(query);
      res.send({ meals, total });
    });

    app.get("/meal/:id", async (req, res) => {
      const meal = await mealsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(meal);
    });

    // Create meal (chef only)
    app.post("/meals", verifyToken, async (req, res) => {
      const meal = req.body;
      meal.createdAt = new Date();
      const result = await mealsCollection.insertOne(meal);
      res.send(result);
    });

    // Update meal
    app.put("/meals/:id", verifyToken, async (req, res) => {
      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      );
      res.send(result);
    });

    // Delete meal
    app.delete("/meals/:id", verifyToken, async (req, res) => {
      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // Reviews
    app.get("/reviews/:foodId", async (req, res) => {
      const reviews = await reviewsCollection
        .find({ foodId: req.params.foodId })
        .sort({ date: -1 })
        .toArray();
      res.send(reviews);
    });

    app.post("/reviews", verifyToken, async (req, res) => {
      const review = req.body;
      review.date = new Date();
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    // Favorites
    app.post("/favorites", verifyToken, async (req, res) => {
      const fav = req.body;
      const exists = await favoritesCollection.findOne({
        userEmail: fav.userEmail,
        mealId: fav.mealId,
      });
      if (exists) return res.send({ message: "Already favorited" });
      const result = await favoritesCollection.insertOne({
        ...fav,
        addedTime: new Date(),
      });
      res.send(result);
    });

    app.get("/favorites/:email", verifyToken, async (req, res) => {
      const favorites = await favoritesCollection
        .find({ userEmail: req.params.email })
        .toArray();
      res.send(favorites);
    });

    app.delete("/favorites/:id", verifyToken, async (req, res) => {
      const result = await favoritesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // Orders
    app.post("/orders", verifyToken, async (req, res) => {
      const order = req.body;
      order.orderTime = new Date();
      order.orderStatus = "pending";
      order.paymentStatus = "Pending";
      const result = await ordersCollection.insertOne(order);
      res.send(result);
    });

    app.get("/orders/:email", verifyToken, async (req, res) => {
      const orders = await ordersCollection
        .find({ userEmail: req.params.email })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    app.get("/orders/chef/:chefId", verifyToken, async (req, res) => {
      const orders = await ordersCollection
        .find({ chefId: req.params.chefId })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    app.patch("/orders/:id", verifyToken, async (req, res) => {
      const { orderStatus } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { orderStatus } }
      );
      res.send(result);
    });

    app.patch("/orders/:id/pay", verifyToken, async (req, res) => {
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { paymentStatus: "paid" } }
      );
      res.send(result);
    });

    // Requests (Be a Chef/Admin)
    app.post("/requests", verifyToken, async (req, res) => {
      const result = await requestsCollection.insertOne(req.body);
      res.send(result);
    });

    app.get("/requests", verifyToken, async (req, res) => {
      const requests = await requestsCollection.find({}).toArray();
      res.send(requests);
    });

    app.patch("/requests/:id", verifyToken, async (req, res) => {
      const { status } = req.body;
      const id = req.params.id;

      const updateResult = await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { requestStatus: status } }
      );

      if (status === "approved") {
        const request = await requestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (request.requestType === "chef") {
          const chefId = `chef-${Math.floor(1000 + Math.random() * 9000)}`;
          await usersCollection.updateOne(
            { email: request.userEmail },
            { $set: { role: "chef", chefId } }
          );
        } else if (request.requestType === "admin") {
          await usersCollection.updateOne(
            { email: request.userEmail },
            { $set: { role: "admin" } }
          );
        }
      }

      res.send(updateResult);
    });

    // Admin Stats
    app.get("/admin/stats", verifyToken, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();
      const pendingOrders = await ordersCollection.countDocuments({
        orderStatus: { $nin: ["delivered", "cancelled"] },
      });
      const deliveredOrders = await ordersCollection.countDocuments({
        orderStatus: "delivered",
      });
      const paidAggregate = await ordersCollection
        .aggregate([
          { $match: { paymentStatus: "paid" } },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: ["$price", "$quantity"] } },
            },
          },
        ])
        .toArray();

      res.send({
        totalUsers,
        totalOrders,
        pendingOrders,
        deliveredOrders,
        totalPayment: paidAggregate[0]?.total || 0,
      });
    });

    // Stripe Payment Intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { totalAmount } = req.body;
      if (!stripe)
        return res.status(500).send({ error: "Stripe not configured" });

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: totalAmount,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // Root route
    app.get("/", (req, res) => {
      res.send("LocalChefBazaar Server is running!");
    });

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

run().catch(console.dir);
