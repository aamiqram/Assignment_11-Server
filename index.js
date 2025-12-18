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

    app.get("/", (req, res) => res.send("Local Chef Bazaar Server Running!"));

    app.listen(port, () =>
      console.log(`Server running on port http://localhost:${port}`)
    );
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
