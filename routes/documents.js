import express from "express"
import fs from "fs"
import path from "path"
import bcrypt from "bcryptjs"
import Document from "../models/Document.js"
import { authenticate } from "../middleware/auth.js"
import { upload, calculateFileHash } from "../middleware/upload.js"

const router = express.Router()

// Upload document with version control
router.post("/upload", authenticate, upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" })
    }

    const { description, tags, accessLevel, accessPin } = req.body

    // Validate access level
    if (!["public", "private", "protected"].includes(accessLevel)) {
      return res.status(400).json({ message: "Invalid access level" })
    }

    // Validate PIN for protected files
    if (accessLevel === "protected" && (!accessPin || accessPin.length < 4)) {
      return res.status(400).json({ message: "Protected files require a PIN of at least 4 characters" })
    }

    // Calculate file hash
    const fileHash = await calculateFileHash(req.file.path)

    // Determine category based on mimetype
    let category = "other"
    if (req.file.mimetype.startsWith("image/")) {
      category = "image"
    } else if (req.file.mimetype === "application/pdf") {
      category = "pdf"
    } else if (req.file.mimetype.includes("document") || req.file.mimetype.includes("text")) {
      category = "document"
    }

    // Create base filename (without extension for version control)
    const baseFileName = path.parse(req.file.originalname).name

    // Check for existing documents with same base filename by same user
    const existingDocs = await Document.find({
      baseFileName: baseFileName,
      uploadedBy: req.user._id,
    }).sort({ version: -1 })

    let version = 1
    let parentDocument = null

    if (existingDocs.length > 0) {
      // Check if file content is different
      const latestDoc = existingDocs[0]
      if (latestDoc.fileHash === fileHash) {
        // Same file content, don't create new version
        fs.unlinkSync(req.file.path) // Delete uploaded file
        return res.status(400).json({
          message: "This file already exists with the same content",
          existingDocument: latestDoc,
        })
      }

      // New version of existing file
      version = latestDoc.version + 1
      parentDocument = latestDoc.parentDocument || latestDoc._id

      // Mark previous versions as not latest
      await Document.updateMany({ baseFileName: baseFileName, uploadedBy: req.user._id }, { isLatestVersion: false })
    }

    // Hash PIN if provided
    let hashedPin = null
    if (accessLevel === "protected" && accessPin) {
      hashedPin = await bcrypt.hash(accessPin, 10)
    }

    const document = new Document({
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      uploadedBy: req.user._id,
      category,
      description: description || "",
      tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
      accessLevel: accessLevel || "private",
      accessPin: hashedPin,
      baseFileName,
      version,
      isLatestVersion: true,
      parentDocument,
      fileHash,
    })

    await document.save()

    // Update version history for all versions of this document
    const versionHistoryEntry = {
      version: document.version,
      documentId: document._id,
      uploadDate: document.createdAt,
      uploadedBy: req.user._id,
    }

    await Document.updateMany(
      {
        $or: [{ _id: parentDocument }, { parentDocument: parentDocument }, { _id: document._id }],
      },
      { $push: { versionHistory: versionHistoryEntry } },
    )

    await document.populate("uploadedBy", "username email")

    res.status(201).json({
      message: `Document uploaded successfully${version > 1 ? ` (Version ${version})` : ""}`,
      document,
      isNewVersion: version > 1,
    })
  } catch (error) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    res.status(500).json({ message: error.message })
  }
})

// Get all documents (with filtering and access control)
router.get("/", authenticate, async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10, showAllVersions = false } = req.query
    const query = {}

    // Access control based on user role
    if (req.user.role !== "admin") {
      query.$or = [
        { uploadedBy: req.user._id }, // Own documents
        { accessLevel: "public" }, // Public documents
      ]
    }

    // Show only latest versions by default
    if (showAllVersions !== "true") {
      query.isLatestVersion = true
    }

    // Filter by category
    if (category && category !== "all") {
      query.category = category
    }

    // Search functionality
    if (search) {
      query.$and = query.$and || []
      query.$and.push({
        $or: [
          { originalName: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { tags: { $in: [new RegExp(search, "i")] } },
          { baseFileName: { $regex: search, $options: "i" } },
        ],
      })
    }

    const documents = await Document.find(query)
      .populate("uploadedBy", "username email")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const total = await Document.countDocuments(query)

    res.json({
      documents,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Verify PIN for protected documents
router.post("/verify-pin/:id", authenticate, async (req, res) => {
  try {
    const { pin } = req.body
    const document = await Document.findById(req.params.id)

    if (!document) {
      return res.status(404).json({ message: "Document not found" })
    }

    if (document.accessLevel !== "protected") {
      return res.status(400).json({ message: "This document is not protected" })
    }

    // Check access permissions
    if (req.user.role !== "admin" && document.uploadedBy.toString() !== req.user._id.toString()) {
      // For protected documents, anyone can try to access with PIN
    }

    // Verify PIN
    const isValidPin = await bcrypt.compare(pin, document.accessPin)
    if (!isValidPin) {
      return res.status(401).json({ message: "Invalid PIN" })
    }

    res.json({ message: "PIN verified successfully", verified: true })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Download document with access control
router.get("/download/:id", authenticate, async (req, res) => {
  try {
    const { pin } = req.query
    const document = await Document.findById(req.params.id)

    if (!document) {
      return res.status(404).json({ message: "Document not found" })
    }

    // Check access permissions
    let hasAccess = false

    if (req.user.role === "admin") {
      hasAccess = true
    } else if (document.uploadedBy.toString() === req.user._id.toString()) {
      hasAccess = true
    } else if (document.accessLevel === "public") {
      hasAccess = true
    } else if (document.accessLevel === "protected" && pin) {
      const isValidPin = await bcrypt.compare(pin, document.accessPin)
      hasAccess = isValidPin
    }

    if (!hasAccess) {
      if (document.accessLevel === "protected") {
        return res.status(401).json({ message: "PIN required for protected document" })
      } else {
        return res.status(403).json({ message: "Access denied" })
      }
    }

    // Construct the full file path
    const filePath = path.resolve(document.path)

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found on server" })
    }

    // Increment download count
    document.downloadCount += 1
    await document.save()

    // Set proper headers for file download
    res.setHeader("Content-Disposition", `attachment; filename="${document.originalName}"`)
    res.setHeader("Content-Type", document.mimetype)
    res.setHeader("Content-Length", document.size)

    // Create read stream and pipe to response
    const fileStream = fs.createReadStream(filePath)

    fileStream.on("error", (error) => {
      console.error("File stream error:", error)
      if (!res.headersSent) {
        res.status(500).json({ message: "Error reading file" })
      }
    })

    fileStream.pipe(res)
  } catch (error) {
    console.error("Download error:", error)
    if (!res.headersSent) {
      res.status(500).json({ message: error.message })
    }
  }
})

// Get document versions
router.get("/:id/versions", authenticate, async (req, res) => {
  try {
    const document = await Document.findById(req.params.id)

    if (!document) {
      return res.status(404).json({ message: "Document not found" })
    }

    // Check access permissions
    if (req.user.role !== "admin" && document.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" })
    }

    // Find all versions of this document
    const versions = await Document.find({
      $or: [
        { _id: document.parentDocument || document._id },
        { parentDocument: document.parentDocument || document._id },
      ],
    })
      .populate("uploadedBy", "username email")
      .sort({ version: -1 })

    res.json({ versions })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

// Delete document
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const document = await Document.findById(req.params.id)

    if (!document) {
      return res.status(404).json({ message: "Document not found" })
    }

    // Check permissions (owner or admin)
    if (req.user.role !== "admin" && document.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" })
    }

    // Delete file from filesystem
    if (fs.existsSync(document.path)) {
      fs.unlinkSync(document.path)
    }

    // If this is the latest version, mark the previous version as latest
    if (document.isLatestVersion && document.version > 1) {
      const previousVersion = await Document.findOne({
        baseFileName: document.baseFileName,
        uploadedBy: document.uploadedBy,
        version: document.version - 1,
      })

      if (previousVersion) {
        previousVersion.isLatestVersion = true
        await previousVersion.save()
      }
    }

    // Remove from version history of related documents
    await Document.updateMany(
      {
        $or: [{ _id: document.parentDocument }, { parentDocument: document.parentDocument }],
      },
      { $pull: { versionHistory: { documentId: document._id } } },
    )

    // Delete from database
    await Document.findByIdAndDelete(req.params.id)

    res.json({ message: "Document deleted successfully" })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

export default router
