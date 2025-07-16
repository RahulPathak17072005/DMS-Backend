import dotenv from "dotenv"
dotenv.config({ path: './.env' })
import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"

import authRoutes from "./routes/auth.js"
import documentRoutes from "./routes/documents.js"
import userRoutes from "./routes/users.js"


const app = express()
const PORT = process.env.PORT || 5000

// Validate required environment variables
const requiredEnvVars = ["MONGODB_URI", "JWT_SECRET", "DROPBOX_ACCESS_TOKEN"]
const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar])

if (missingEnvVars.length > 0) {
  console.error("Missing required environment variables:", missingEnvVars)
  console.error("Please check your .env file and ensure all required variables are set")
  process.exit(1)
}

console.log("Environment variables loaded:")
console.log("- MongoDB URI:", process.env.MONGODB_URI ? "✓ Set" : "✗ Missing")
console.log("- JWT Secret:", process.env.JWT_SECRET ? "✓ Set" : "✗ Missing")
console.log("- Dropbox Token:", process.env.DROPBOX_ACCESS_TOKEN ? "✓ Set" : "✗ Missing")

// Security middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }),
)

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
})
app.use(limiter)

// Body parsing middleware
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// Database connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/document-management")
  .then(() => console.log("✓ Connected to MongoDB"))
  .catch((err) => {
    console.error("✗ MongoDB connection error:", err)
    process.exit(1)
  })

// Routes
app.use("/api/auth", authRoutes)
app.use("/api/documents", documentRoutes)
app.use("/api/users", userRoutes)

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    dropbox: process.env.DROPBOX_ACCESS_TOKEN ? "Connected" : "Not configured",
  })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err.stack)

  // Handle multer errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ message: "File too large. Maximum size is 10MB." })
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ message: "Unexpected file field." })
  }

  // Handle other errors
  res.status(500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "development" ? err.message : "Internal server error",
  })
})

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`)
  console.log(`✓ Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:5173"}`)
})
