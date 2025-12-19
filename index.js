require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Firebase Admin Initialization
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

// Stripe Initialization (safe)
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn("STRIPE_SECRET_KEY missing — payments disabled");
}

// CORS - Allow your client origins
app.use(
  cors({
    origin: ["http://localhost:5173", "https://local-chef-bazar.netlify.app"],
    credentials: true,
  })
);

app.use(express.json());

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

    // MIDDLEWARE: Verify Firebase ID Token from Authorization header
    const verifyFirebaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized - No token" });
      }

      const idToken = authHeader.split("Bearer ")[1];

      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = { email: decodedToken.email };
        next();
      } catch (error) {
        console.error("Invalid Firebase token:", error.message);
        return res
          .status(401)
          .send({ message: "Unauthorized - Invalid token" });
      }
    };

    // PUBLIC ROUTES
    app.get("/", (req, res) => {
      res.send("LocalChefBazaar Server is running! 🚀");
    });

    // Meals (public)
    app.get("/meals", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";
      const sort = req.query.sort;
      const chefEmail = req.query.chefEmail;
      let query = {};
      if (search) query.foodName = { $regex: search, $options: "i" };
      if (chefEmail) query.userEmail = chefEmail;
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
      if (!meal) return res.status(404).send({ message: "Meal not found" });
      res.send(meal);
    });

    app.get("/reviews/:foodId", async (req, res) => {
      const reviews = await reviewsCollection
        .find({ foodId: req.params.foodId })
        .sort({ date: -1 })
        .toArray();
      res.send(reviews);
    });

    app.get("/recent-reviews", async (req, res) => {
      const reviews = await reviewsCollection
        .find({})
        .sort({ date: -1 })
        .limit(6)
        .toArray();
      res.send(reviews);
    });

    // PROTECTED ROUTES
    // Sync or create user on first login
    app.put("/users", verifyFirebaseToken, async (req, res) => {
      const userData = req.body;
      userData.email = req.user.email; // ensure email from token

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
    app.get("/user/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: "Forbidden" });
      }
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).send({ message: "User not found" });
      res.send(user);
    });

    // Get user role
    app.get("/user/role/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: "Forbidden" });
      }
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || "user" });
    });

    // Create meal (chef only)
    app.post("/meals", verifyFirebaseToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "chef")
        return res.status(403).send({ message: "Only chefs can create meals" });

      const meal = req.body;
      meal.chefId = user.chefId;
      meal.userEmail = req.user.email;
      meal.createdAt = new Date();

      const result = await mealsCollection.insertOne(meal);
      res.send(result);
    });

    // Update/Delete meal (chef only)
    app.put("/meals/:id", verifyFirebaseToken, async (req, res) => {
      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(req.params.id), userEmail: req.user.email },
        { $set: req.body }
      );
      res.send(result);
    });

    app.delete("/meals/:id", verifyFirebaseToken, async (req, res) => {
      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        userEmail: req.user.email,
      });
      res.send(result);
    });

    // Reviews
    app.post("/reviews", verifyFirebaseToken, async (req, res) => {
      const review = req.body;
      review.reviewerEmail = req.user.email;
      review.date = new Date();
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    // Favorites
    app.post("/favorites", verifyFirebaseToken, async (req, res) => {
      const fav = req.body;
      fav.userEmail = req.user.email;
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

    app.get("/favorites/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email)
        return res.status(403).send({ message: "Forbidden" });
      const favorites = await favoritesCollection
        .find({ userEmail: req.params.email })
        .toArray();
      res.send(favorites);
    });

    app.delete("/favorites/:id", verifyFirebaseToken, async (req, res) => {
      const result = await favoritesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // Orders
    app.post("/orders", verifyFirebaseToken, async (req, res) => {
      const order = req.body;
      order.userEmail = req.user.email;
      order.orderTime = new Date();
      order.orderStatus = "pending";
      order.paymentStatus = "Pending";
      const result = await ordersCollection.insertOne(order);
      res.send(result);
    });

    app.get("/orders/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email)
        return res.status(403).send({ message: "Forbidden" });
      const orders = await ordersCollection
        .find({ userEmail: req.params.email })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    app.get("/orders/chef/:chefId", verifyFirebaseToken, async (req, res) => {
      const orders = await ordersCollection
        .find({ chefId: req.params.chefId })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    app.patch("/orders/:id", verifyFirebaseToken, async (req, res) => {
      const { orderStatus } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { orderStatus } }
      );
      res.send(result);
    });

    app.patch("/orders/:id/pay", verifyFirebaseToken, async (req, res) => {
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { paymentStatus: "paid" } }
      );
      res.send(result);
    });

    // Requests
    app.post("/requests", verifyFirebaseToken, async (req, res) => {
      const request = req.body;
      request.userEmail = req.user.email;
      request.requestTime = new Date();
      request.requestStatus = "pending";
      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    app.get("/requests", verifyFirebaseToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "admin")
        return res.status(403).send({ message: "Admin only" });
      const requests = await requestsCollection.find({}).toArray();
      res.send(requests);
    });

    app.patch("/requests/:id", verifyFirebaseToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "admin")
        return res.status(403).send({ message: "Admin only" });

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
    app.get("/admin/stats", verifyFirebaseToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "admin")
        return res.status(403).send({ message: "Admin only" });

      const totalUsers = await usersCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();
      const pendingOrders = await ordersCollection.countDocuments({
        orderStatus: "pending",
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
    app.post(
      "/create-payment-intent",
      verifyFirebaseToken,
      async (req, res) => {
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
      }
    );

    // GET reviews by user email (for My Reviews page)
    app.get("/reviews/user/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      const reviews = await reviewsCollection
        .find({ reviewerEmail: req.params.email })
        .sort({ date: -1 })
        .toArray();

      res.send(reviews);
    });

    // DELETE review by ID
    app.delete("/reviews/:id", verifyFirebaseToken, async (req, res) => {
      const review = await reviewsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!review) return res.status(404).send({ message: "Review not found" });
      if (review.reviewerEmail !== req.user.email) {
        return res
          .status(403)
          .send({ message: "You can only delete your own reviews" });
      }

      const result = await reviewsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // UPDATE review by ID
    app.put("/reviews/:id", verifyFirebaseToken, async (req, res) => {
      const { rating, comment } = req.body;
      const review = await reviewsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!review) return res.status(404).send({ message: "Review not found" });
      if (review.reviewerEmail !== req.user.email) {
        return res
          .status(403)
          .send({ message: "You can only update your own reviews" });
      }

      const result = await reviewsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { rating, comment, date: new Date() } }
      );

      res.send(result);
    });

    // GET all users (Admin only)
    app.get("/users", verifyFirebaseToken, async (req, res) => {
      const requester = await usersCollection.findOne({
        email: req.user.email,
      });
      if (requester?.role !== "admin") {
        return res.status(403).send({ message: "Admin access required" });
      }

      const users = await usersCollection.find({}).toArray();
      res.send(users);
    });

    // Mark user as fraud (Admin only)
    app.patch("/users/fraud/:email", verifyFirebaseToken, async (req, res) => {
      const requester = await usersCollection.findOne({
        email: req.user.email,
      });
      if (requester?.role !== "admin") {
        return res.status(403).send({ message: "Admin access required" });
      }

      const email = req.params.email;
      const targetUser = await usersCollection.findOne({ email });
      if (!targetUser)
        return res.status(404).send({ message: "User not found" });
      if (targetUser.role === "admin")
        return res.status(400).send({ message: "Cannot mark admin as fraud" });

      const result = await usersCollection.updateOne(
        { email },
        { $set: { status: "fraud" } }
      );

      res.send(result);
    });

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Local: http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Server error:", err);
  }
}

run().catch(console.dir);
