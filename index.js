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
    origin: [
      "http://localhost:5173",
      "https://local-chef-bazar.netlify.app",
      "http://localhost:5174",
      "https://local-chef-bazar.vercel.app",
    ],
    credentials: true,
  }),
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
        { upsert: true },
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

      // Allow demo role override via header for demo accounts
      const demoRole = req.headers["x-demo-role"];
      if (demoRole && user?.email) {
        // For demo accounts, allow role switching
        const isDemo =
          user.email.includes("demo") || user.email.includes("localchefbazaar");
        if (isDemo && ["user", "chef", "admin"].includes(demoRole)) {
          return res.send({ role: demoRole });
        }
      }

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
        { $set: req.body },
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
        mealImage: fav.mealImage || "https://i.ibb.co.com/placeholder.jpg",
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
        { $set: { orderStatus } },
      );
      res.send(result);
    });

    app.patch("/orders/:id/pay", verifyFirebaseToken, async (req, res) => {
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { paymentStatus: "paid" } },
      );
      res.send(result);
    });

    // Requests
    app.post("/requests", verifyFirebaseToken, async (req, res) => {
      const request = req.body;
      request.userEmail = req.user.email;
      request.requestTime = new Date();
      request.requestStatus = "pending";
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user) {
        request.image =
          user.imageURL || "https://i.ibb.co.com/0s3pdnc/avatar.png";
      }
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
        { $set: { requestStatus: status } },
      );

      if (status === "approved") {
        const request = await requestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (request.requestType === "chef") {
          const chefId = `chef-${Math.floor(1000 + Math.random() * 9000)}`;
          await usersCollection.updateOne(
            { email: request.userEmail },
            { $set: { role: "chef", chefId } },
          );
        } else if (request.requestType === "admin") {
          await usersCollection.updateOne(
            { email: request.userEmail },
            { $set: { role: "admin" } },
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
      const totalMeals = await mealsCollection.countDocuments();
      const totalOrders = await ordersCollection.countDocuments();
      const pendingOrders = await ordersCollection.countDocuments({
        orderStatus: "pending",
      });
      const deliveredOrders = await ordersCollection.countDocuments({
        orderStatus: "delivered",
      });
      const newUsersToday = await usersCollection.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      });
      const ordersToday = await ordersCollection.countDocuments({
        orderTime: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
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
        totalMeals,
        totalOrders,
        pendingOrders,
        deliveredOrders,
        newUsersToday,
        ordersToday,
        totalRevenue: paidAggregate[0]?.total || 0,
      });
    });

    // Chef Stats
    app.get("/chef/stats/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      const chef = await usersCollection.findOne({ email: req.params.email });
      if (!chef || chef.role !== "chef") {
        return res.status(403).send({ message: "Chef only" });
      }

      const chefMeals = await mealsCollection.countDocuments({
        userEmail: req.params.email,
      });
      const pendingOrders = await ordersCollection.countDocuments({
        chefId: chef.chefId,
        orderStatus: "pending",
      });
      const completedOrders = await ordersCollection.countDocuments({
        chefId: chef.chefId,
        orderStatus: "delivered",
      });
      const totalOrders = await ordersCollection.countDocuments({
        chefId: chef.chefId,
      });

      // Calculate total earnings from delivered/paid orders
      const earningsAggregate = await ordersCollection
        .aggregate([
          {
            $match: {
              chefId: chef.chefId,
              orderStatus: "delivered",
              paymentStatus: "paid",
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: ["$price", "$quantity"] } },
            },
          },
        ])
        .toArray();

      // Calculate average rating from meals
      const mealRatings = await mealsCollection
        .find({ userEmail: req.params.email, rating: { $exists: true } })
        .toArray();

      const avgRating =
        mealRatings.length > 0
          ? (
              mealRatings.reduce((sum, meal) => sum + (meal.rating || 0), 0) /
              mealRatings.length
            ).toFixed(1)
          : "N/A";

      res.send({
        totalMeals: chefMeals,
        pendingOrders,
        completedOrders,
        totalOrders,
        totalEarnings: earningsAggregate[0]?.total || 0,
        averageRating: avgRating,
      });
    });

    // User Stats
    app.get("/user/stats/:email", verifyFirebaseToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      const totalOrders = await ordersCollection.countDocuments({
        userEmail: req.params.email,
      });
      const activeOrders = await ordersCollection.countDocuments({
        userEmail: req.params.email,
        orderStatus: {
          $in: ["pending", "accepted", "preparing", "out_for_delivery"],
        },
      });
      const completedOrders = await ordersCollection.countDocuments({
        userEmail: req.params.email,
        orderStatus: "delivered",
      });
      const favorites = await favoritesCollection.countDocuments({
        userEmail: req.params.email,
      });
      const reviews = await reviewsCollection.countDocuments({
        reviewerEmail: req.params.email,
      });

      // Calculate total spent
      const spentAggregate = await ordersCollection
        .aggregate([
          {
            $match: {
              userEmail: req.params.email,
              paymentStatus: "paid",
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: ["$price", "$quantity"] } },
            },
          },
        ])
        .toArray();

      res.send({
        totalOrders,
        activeOrders,
        completedOrders,
        favorites,
        reviews,
        totalSpent: spentAggregate[0]?.total || 0,
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
      },
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
        { $set: { rating, comment, date: new Date() } },
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
        { $set: { status: "fraud" } },
      );

      res.send(result);
    });

    // Filter meals by multiple criteria
    app.get("/meals/filter", async (req, res) => {
      try {
        const {
          category,
          minPrice,
          maxPrice,
          rating,
          chefId,
          page = 1,
          limit = 10,
          search = "",
          sort = "",
        } = req.query;

        let query = {};

        // Search by food name
        if (search) {
          query.foodName = { $regex: search, $options: "i" };
        }

        // Filter by category
        if (category && category !== "all") {
          query.category = category;
        }

        // Filter by price range
        if (minPrice || maxPrice) {
          query.price = {};
          if (minPrice) query.price.$gte = parseFloat(minPrice);
          if (maxPrice) query.price.$lte = parseFloat(maxPrice);
        }

        // Filter by rating
        if (rating) {
          query.rating = { $gte: parseFloat(rating) };
        }

        // Filter by chef
        if (chefId) {
          query.chefId = chefId;
        }

        // Sorting
        let sortObj = {};
        if (sort === "price-asc") sortObj.price = 1;
        if (sort === "price-desc") sortObj.price = -1;
        if (sort === "rating-desc") sortObj.rating = -1;
        if (sort === "date-desc") sortObj.createdAt = -1;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const meals = await mealsCollection
          .find(query)
          .sort(sortObj)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await mealsCollection.countDocuments(query);

        res.send({
          success: true,
          data: meals,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit)),
          },
        });
      } catch (error) {
        console.error("Filter error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Home page statistics
    app.get("/stats/home", async (req, res) => {
      try {
        const totalMeals = await mealsCollection.countDocuments();
        const totalChefs = await usersCollection.countDocuments({
          role: "chef",
        });
        const totalOrders = await ordersCollection.countDocuments();

        // Get top-rated meals (4+ stars)
        const topRatedMeals = await mealsCollection
          .find({ rating: { $gte: 4 } })
          .sort({ rating: -1 })
          .limit(6)
          .toArray();

        // Calculate total revenue from paid orders
        const revenueAggregate = await ordersCollection
          .aggregate([
            { $match: { paymentStatus: "paid" } },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: { $multiply: ["$price", "$quantity"] } },
              },
            },
          ])
          .toArray();

        res.send({
          success: true,
          data: {
            totalMeals,
            totalChefs,
            totalOrders,
            totalRevenue: revenueAggregate[0]?.totalRevenue || 0,
            topRatedMeals,
          },
        });
      } catch (error) {
        console.error("Stats error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Featured chefs endpoint (with optional limit)
    app.get("/chefs/featured", async (req, res) => {
      try {
        const { limit = 6 } = req.query;

        const chefs = await usersCollection.find({ role: "chef" }).toArray();

        // Get chef statistics
        const chefStats = await Promise.all(
          chefs.map(async (chef) => {
            const mealCount = await mealsCollection.countDocuments({
              userEmail: chef.email,
            });

            // Calculate average rating from meals
            const mealRatings = await mealsCollection
              .find({ userEmail: chef.email, rating: { $exists: true } })
              .toArray();

            const avgRating =
              mealRatings.length > 0
                ? mealRatings.reduce(
                    (sum, meal) => sum + (meal.rating || 0),
                    0,
                  ) / mealRatings.length
                : 0;

            return {
              _id: chef._id,
              name: chef.name,
              email: chef.email,
              image: chef.image || "https://i.ibb.co.com/0s3pdnc/avatar.png",
              chefId: chef.chefId,
              role: chef.role,
              mealCount,
              avgRating: parseFloat(avgRating.toFixed(1)),
              createdAt: chef.createdAt,
            };
          }),
        );

        // Filter featured chefs (4+ rating and at least 5 meals)
        let featuredChefs = chefStats
          .filter((chef) => chef.avgRating >= 4 && chef.mealCount >= 5)
          .sort((a, b) => b.avgRating - a.avgRating);

        // Apply limit
        if (limit) {
          featuredChefs = featuredChefs.slice(0, parseInt(limit));
        }

        res.send({
          success: true,
          data: featuredChefs,
        });
      } catch (error) {
        console.error("Featured chefs error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Alternative endpoint for /chefs?featured=true (if frontend needs this format)
    app.get("/chefs", async (req, res) => {
      try {
        const { featured, limit } = req.query;

        if (featured === "true") {
          // Redirect to featured chefs endpoint
          const chefs = await usersCollection.find({ role: "chef" }).toArray();

          const chefStats = await Promise.all(
            chefs.map(async (chef) => {
              const mealCount = await mealsCollection.countDocuments({
                userEmail: chef.email,
              });

              const mealRatings = await mealsCollection
                .find({ userEmail: chef.email, rating: { $exists: true } })
                .toArray();

              const avgRating =
                mealRatings.length > 0
                  ? mealRatings.reduce(
                      (sum, meal) => sum + (meal.rating || 0),
                      0,
                    ) / mealRatings.length
                  : 0;

              return {
                ...chef,
                mealCount,
                avgRating: parseFloat(avgRating.toFixed(1)),
              };
            }),
          );

          let featuredChefs = chefStats
            .filter((chef) => chef.avgRating >= 4 && chef.mealCount >= 5)
            .sort((a, b) => b.avgRating - a.avgRating);

          if (limit) {
            featuredChefs = featuredChefs.slice(0, parseInt(limit));
          }

          return res.send(featuredChefs);
        }

        // If not featured, return all chefs
        const allChefs = await usersCollection.find({ role: "chef" }).toArray();

        res.send(allChefs);
      } catch (error) {
        console.error("Chefs endpoint error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Get meals by chef ID (for related meals)
    app.get("/meals/chef/:chefId", async (req, res) => {
      try {
        const { chefId } = req.params;
        const { excludeId, limit = 4 } = req.query;

        let query = { chefId };

        if (excludeId) {
          query._id = { $ne: new ObjectId(excludeId) };
        }

        const meals = await mealsCollection
          .find(query)
          .limit(parseInt(limit))
          .toArray();

        res.send({
          success: true,
          data: meals,
        });
      } catch (error) {
        console.error("Chef meals error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Get chef details by ID
    app.get("/chef/:chefId", async (req, res) => {
      try {
        const chef = await usersCollection.findOne({
          chefId: req.params.chefId,
          role: "chef",
        });

        if (!chef) {
          return res.status(404).send({
            success: false,
            message: "Chef not found",
          });
        }

        const meals = await mealsCollection
          .find({ userEmail: chef.email })
          .toArray();

        const stats = {
          totalMeals: meals.length,
          avgRating:
            meals.length > 0
              ? meals.reduce((sum, meal) => sum + (meal.rating || 0), 0) /
                meals.length
              : 0,
          totalOrders: await ordersCollection.countDocuments({
            chefId: chef.chefId,
          }),
        };

        res.send({
          success: true,
          data: {
            chef,
            meals,
            stats,
          },
        });
      } catch (error) {
        console.error("Chef details error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Top rated meals
    app.get("/meals/top-rated", async (req, res) => {
      try {
        const { limit = 6 } = req.query;

        const meals = await mealsCollection
          .find({ rating: { $gte: 4 } })
          .sort({ rating: -1 })
          .limit(parseInt(limit))
          .toArray();

        res.send({
          success: true,
          data: meals,
        });
      } catch (error) {
        console.error("Top rated meals error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Get all categories
    app.get("/meals/categories", async (req, res) => {
      try {
        const categories = await mealsCollection.distinct("category");
        res.send({
          success: true,
          data: categories,
        });
      } catch (error) {
        console.error("Categories error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
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
