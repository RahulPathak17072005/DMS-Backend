import express from "express"
import User from "../models/User.js"
import { authenticate, authorize } from "../middleware/auth.js"

const router = express.Router()

// Get all users (admin only)
router.get("/", authenticate, authorize("admin"), async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 })
    res.json({ users })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Toggle user status (admin only)
router.patch("/:id/toggle-status", authenticate, authorize("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    user.isActive = !user.isActive
    await user.save()

    res.json({
      message: `User ${user.isActive ? "activated" : "deactivated"} successfully`,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Update user role (admin only)
router.patch("/:id/role", authenticate, authorize("admin"), async (req, res) => {
  try {
    const { role } = req.body

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ message: "Invalid role" })
    }

    const user = await User.findById(req.params.id)

    if (!user) {
      return res.status(404).json({ message: "User not found" })
    }

    user.role = role
    await user.save()

    res.json({
      message: "User role updated successfully",
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

export default router
