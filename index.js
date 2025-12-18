require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://local-chef-bazaar-5655a.web.app/",
    ],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Firebase Admin Initialization
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

// MongoDB Connection
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1 },
});

async function run() {
  try {
    await client.connect();
    const usersCollection = client.db("localchefbazaar").collection("users");

    // JWT Endpoint
    app.post("/jwt", async (req, res) => {
      const { idToken } = req.body;

      if (!idToken) {
        return res
          .status(400)
          .send({ success: false, message: "No token provided" });
      }

      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        console.log(
          "Firebase token verified successfully:",
          decodedToken.email
        );

        const token = jwt.sign(
          { email: decodedToken.email, uid: decodedToken.uid },
          process.env.JWT_SECRET,
          { expiresIn: "30d" }
        );

        res.cookie("token", token, {
          httpOnly: true,
          secure: false, // set true only in production (HTTPS)
          sameSite: "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        res.send({ success: true });
      } catch (error) {
        console.error("Firebase token verification failed:", error.message);
        res
          .status(401)
          .send({ success: false, message: "Invalid Firebase token" });
      }
    });

    // Save or Update User
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existing = await usersCollection.findOne(query);
      if (existing) return res.send({ message: "User exists" });
      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        status: "active",
      });
      res.send(result);
    });

    const mealsCollection = client.db("localchefbazaar").collection("meals");
    const reviewsCollection = client
      .db("localchefbazaar")
      .collection("reviews");
    const favoritesCollection = client
      .db("localchefbazaar")
      .collection("favorites");

    // Verify JWT Middleware
    const verifyToken = (req, res, next) => {
      const token = req.cookies?.token;
      if (!token) return res.status(401).send({ message: "Unauthorized" });
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: "Unauthorized" });
        req.decoded = decoded;
        next();
      });
    };

    // GET meals with search, sort, pagination
    app.get("/meals", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";
      const sort = req.query.sort; // 'asc', 'desc'

      let query = {};
      if (search) {
        query.foodName = { $regex: search, $options: "i" };
      }

      let sortObj = {};
      if (sort === "asc") sortObj.price = 1;
      if (sort === "desc") sortObj.price = -1;

      const result = await mealsCollection
        .find(query)
        .sort(sortObj)
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

      const total = await mealsCollection.countDocuments(query);
      res.send({ meals: result, total });
    });

    // GET single meal
    app.get("/meal/:id", async (req, res) => {
      const meal = await mealsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(meal);
    });

    // GET reviews for a meal
    app.get("/reviews/:foodId", async (req, res) => {
      const reviews = await reviewsCollection
        .find({ foodId: req.params.foodId })
        .sort({ date: -1 })
        .toArray();
      res.send(reviews);
    });

    // POST review (protected)
    app.post("/reviews", verifyToken, async (req, res) => {
      const review = req.body;
      review.date = new Date().toISOString();
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });

    // POST favorite (protected)
    app.post("/favorites", verifyToken, async (req, res) => {
      const fav = req.body;
      const query = { userEmail: fav.userEmail, mealId: fav.mealId };
      const exists = await favoritesCollection.findOne(query);
      if (exists) return res.send({ message: "Already favorited" });
      const result = await favoritesCollection.insertOne({
        ...fav,
        addedTime: new Date().toISOString(),
      });
      res.send(result);
    });

    // GET user favorites
    app.get("/favorites/:email", verifyToken, async (req, res) => {
      const favorites = await favoritesCollection
        .find({ userEmail: req.params.email })
        .toArray();
      res.send(favorites);
    });

    // GET user's reviews
    app.get("/reviews/user/:email", verifyToken, async (req, res) => {
      const reviews = await reviewsCollection
        .find({ reviewerEmail: req.params.email })
        .toArray();
      res.send(reviews);
    });

    // DELETE review
    app.delete("/reviews/:id", verifyToken, async (req, res) => {
      const result = await reviewsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // PUT update review
    app.put("/reviews/:id", verifyToken, async (req, res) => {
      const { rating, comment } = req.body;
      const result = await reviewsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { rating, comment } }
      );
      res.send(result);
    });

    // DELETE favorite
    app.delete("/favorites/:id", verifyToken, async (req, res) => {
      const result = await favoritesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    const ordersCollection = client.db("localchefbazaar").collection("orders");

    // POST order (protected)
    app.post("/orders", verifyToken, async (req, res) => {
      const order = req.body;
      order.orderTime = new Date().toISOString();
      order.orderStatus = "pending";
      order.paymentStatus = "Pending";
      const result = await ordersCollection.insertOne(order);
      res.send(result);
    });

    // GET my orders
    app.get("/orders/:email", verifyToken, async (req, res) => {
      const orders = await ordersCollection
        .find({ userEmail: req.params.email })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    app.get("/user/role/:email", verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({ role: user?.role || "user" });
    });

    const requestsCollection = client
      .db("localchefbazaar")
      .collection("requests");

    // POST request to become chef/admin
    app.post("/requests", verifyToken, async (req, res) => {
      const request = req.body;
      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    // GET all requests (admin only)
    app.get("/requests", verifyToken, async (req, res) => {
      // Add admin verification middleware later
      const requests = await requestsCollection.find({}).toArray();
      res.send(requests);
    });

    // PATCH approve/reject request (admin only)
    app.patch("/requests/:id", verifyToken, async (req, res) => {
      const { status } = req.body; // 'approved' or 'rejected'
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

    // POST create meal (chef only)
    app.post("/meals", verifyToken, async (req, res) => {
      const meal = req.body;
      meal.createdAt = new Date();
      const result = await mealsCollection.insertOne(meal);
      res.send(result);
    });

    // GET single user by email (for CreateMeal, Profile, etc.)
    app.get("/user/:email", verifyToken, async (req, res) => {
      const email = req.params.email;

      try {
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // PUT update meal
    app.put("/meals/:id", verifyToken, async (req, res) => {
      const updatedMeal = req.body;
      const result = await mealsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updatedMeal }
      );
      res.send(result);
    });

    // DELETE meal
    app.delete("/meals/:id", verifyToken, async (req, res) => {
      const result = await mealsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // GET orders for chef (by chefId)
    app.get("/orders/chef/:chefId", verifyToken, async (req, res) => {
      const orders = await ordersCollection
        .find({ chefId: req.params.chefId })
        .sort({ orderTime: -1 })
        .toArray();
      res.send(orders);
    });

    // PATCH update order status
    app.patch("/orders/:id", verifyToken, async (req, res) => {
      const { orderStatus } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { orderStatus } }
      );
      res.send(result);
    });

    // PATCH make user fraud
    app.patch("/users/fraud/:email", verifyToken, async (req, res) => {
      const result = await usersCollection.updateOne(
        { email: req.params.email, role: { $ne: "admin" } },
        { $set: { status: "fraud" } }
      );
      res.send(result);
    });

    // GET all users (admin)
    app.get("/users", verifyToken, async (req, res) => {
      const users = await usersCollection.find({}).toArray();
      res.send(users);
    });

    // GET platform stats (admin)
    app.get("/admin/stats", verifyToken, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();
      const pendingOrders = await ordersCollection.countDocuments({
        orderStatus: { $ne: "delivered" },
      });
      const deliveredOrders = await ordersCollection.countDocuments({
        orderStatus: "delivered",
      });
      const totalPaid = await ordersCollection
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
        totalPayment: totalPaid[0]?.total || 0,
      });
    });

    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { totalAmount } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: totalAmount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    app.patch("/orders/:id/pay", verifyToken, async (req, res) => {
      await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { paymentStatus: "paid" } }
      );
      res.send({ success: true });
    });

    app.get("/", (req, res) => res.send("Local Chef Bazaar Server Running!"));

    app.listen(port, () =>
      console.log(`Server running on port http://localhost:${port}`)
    );
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
