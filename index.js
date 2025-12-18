require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion } = require("mongodb");

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
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const token = jwt.sign(
          { email: decoded.email },
          process.env.JWT_SECRET,
          { expiresIn: "7d" }
        );
        res.cookie("token", token, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
        });
        res.send({ success: true });
      } catch (err) {
        res.status(401).send({ success: false });
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

    app.get("/", (req, res) => res.send("Local Chef Bazaar Server Running!"));

    app.listen(port, () =>
      console.log(`Server running on port http://localhost:${port}`)
    );
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
