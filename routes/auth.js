import express from "express"
import jwt from "jsonwebtoken"
import User from "../models/User.js"
import { authenticate } from "../middleware/auth.js"

const router = express.Router()

// Register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password, role, adminSecret } = req.body

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    })

    if (existingUser) {
      return res.status(400).json({
        message: "User with this email or username already exists",
      })
    }

    // Determine user role
    let userRole = "user"
    if (role === "admin") {
      // For admin registration, require admin secret
      if (adminSecret === process.env.ADMIN_SECRET || adminSecret === "admin123") {
        userRole = "admin"
      } else {
        return res.status(403).json({
          message: "Invalid admin secret for admin registration",
        })
      }
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
      role: userRole,
    })

    await user.save()

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" })

    res.status(201).json({
      message: "User created successfully",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Register admin (special endpoint for creating admin users)
router.post("/register-admin", async (req, res) => {
  try {
    const { username, email, password, adminSecret } = req.body

    // Check admin secret (you can change this to your preferred secret)
    if (adminSecret !== process.env.ADMIN_SECRET && adminSecret !== "admin123") {
      return res.status(403).json({
        message: "Invalid admin secret",
      })
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    })

    if (existingUser) {
      return res.status(400).json({
        message: "User with this email or username already exists",
      })
    }

    // Create new admin user
    const user = new User({
      username,
      email,
      password,
      role: "admin",
    })

    await user.save()

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" })

    res.status(201).json({
      message: "Admin user created successfully",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body

    // Find user
    const user = await User.findOne({ email })
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid credentials" })
    }

    // Check password
    const isMatch = await user.comparePassword(password)
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" })
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" })

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Get current user
router.get("/me", authenticate, (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
    },
  })
})

export default router
