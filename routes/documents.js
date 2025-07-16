import express from "express"
import bcrypt from "bcryptjs"
import Document from "../models/Document.js"
import { authenticate } from "../middleware/auth.js"
import {
  upload,
  calculateFileHash,
  uploadToDropbox,
  downloadFromDropbox,
  deleteFromDropbox,
} from "../middleware/upload.js"
import path from "path"

const router = express.Router()

// Upload document with version control and Dropbox storage
router.post("/upload", authenticate, upload.single("document"), async (req, res) => {
  try {
    console.log("Upload request received")
    console.log("User:", req.user.username)
    console.log("File:", req.file ? req.file.originalname : "No file")
    console.log("Body:", req.body)

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

    console.log("Calculating file hash...")
    // Calculate file hash from buffer
    const fileHash = calculateFileHash(req.file.buffer)
    console.log("File hash calculated:", fileHash.substring(0, 10) + "...")

    console.log("Uploading to Dropbox...")
    // Upload to Dropbox
    const dropboxResult = await uploadToDropbox(req.file.buffer, req.file.originalname, req.file.originalname)
    console.log("Dropbox upload result:", dropboxResult)

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

    console.log("Checking for existing documents...")
    // Check for existing documents with same base filename by same user
    const existingDocs = await Document.find({
      baseFileName: baseFileName,
      uploadedBy: req.user._id,
    }).sort({ version: -1 })

    let version = 1
    let parentDocument = null

    if (existingDocs.length > 0) {
      console.log("Found existing versions:", existingDocs.length)
      // New version of existing file
      version = existingDocs[0].version + 1
      parentDocument = existingDocs[0].parentDocument || existingDocs[0]._id

      // Mark previous versions as not latest
      await Document.updateMany(
        {
          baseFileName: baseFileName,
          uploadedBy: req.user._id,
        },
        { isLatestVersion: false },
      )
    }

    // Hash PIN if provided
    let hashedPin = null
    if (accessLevel === "protected" && accessPin) {
      console.log("Hashing PIN...")
      hashedPin = await bcrypt.hash(accessPin, 10)
    }

    console.log("Creating document record...")
    const document = new Document({
      filename: dropboxResult.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      dropboxPath: dropboxResult.dropboxPath,
      dropboxFileId: dropboxResult.dropboxFileId,
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
    console.log("Document saved to database:", document._id)

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

    console.log("Upload completed successfully")
    res.status(201).json({
      message: `Document uploaded successfully to Dropbox${version > 1 ? ` (Version ${version})` : ""}`,
      document,
      isNewVersion: version > 1,
      version: version,
    })
  } catch (error) {
    console.error("Upload error:", error)

    // Provide more specific error messages
    if (error.message.includes("Dropbox")) {
      res.status(500).json({
        message: "Cloud storage error: " + error.message,
        details: "Please check your Dropbox configuration and try again.",
      })
    } else if (error.message.includes("validation")) {
      res.status(400).json({ message: error.message })
    } else {
      res.status(500).json({
        message: "Upload failed: " + error.message,
        details: "Please try again or contact support if the problem persists.",
      })
    }
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
        { accessLevel: "protected" }, // Protected documents (can be accessed with PIN)
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
    console.error("Get documents error:", error)
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

    if (!pin) {
      return res.status(400).json({ message: "PIN is required" })
    }

    console.log("Verifying PIN for document:", document.originalName)

    // Verify PIN
    const isValidPin = await bcrypt.compare(pin, document.accessPin)
    if (!isValidPin) {
      console.log("Invalid PIN provided")
      return res.status(401).json({ message: "Invalid PIN" })
    }

    console.log("PIN verified successfully")
    res.json({ message: "PIN verified successfully", verified: true })
  } catch (error) {
    console.error("PIN verification error:", error)
    res.status(500).json({ message: error.message })
  }
})

// Download document with access control and Dropbox integration
router.get("/download/:id", authenticate, async (req, res) => {
  let document = null

  try {
    console.log("=== DOWNLOAD REQUEST START ===")
    console.log("Document ID:", req.params.id)
    console.log("User ID:", req.user._id)
    console.log("User Role:", req.user.role)
    console.log("Query params:", req.query)

    const { pin } = req.query

    // Find document with populated user data
    document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      console.log("❌ Document not found in database")
      return res.status(404).json({ message: "Document not found" })
    }

    console.log("✅ Document found:", {
      id: document._id,
      name: document.originalName,
      accessLevel: document.accessLevel,
      uploadedBy: document.uploadedBy?._id,
      dropboxPath: document.dropboxPath,
      size: document.size,
    })

    // Validate required fields
    if (!document.dropboxPath) {
      console.log("❌ No Dropbox path found")
      return res.status(500).json({
        message: "File path not found. This file may have been corrupted during upload.",
        error: "MISSING_DROPBOX_PATH",
      })
    }

    if (!document.uploadedBy) {
      console.log("❌ No uploader information found")
      return res.status(500).json({
        message: "File uploader information not found.",
        error: "MISSING_UPLOADER",
      })
    }

    // Check access permissions based on access level
    let hasAccess = false
    let accessReason = ""

    if (document.accessLevel === "public") {
      hasAccess = true
      accessReason = "Public file"
    } else if (document.accessLevel === "private") {
      if (req.user.role === "admin") {
        hasAccess = true
        accessReason = "Admin access to private file"
      } else if (document.uploadedBy._id.toString() === req.user._id.toString()) {
        hasAccess = true
        accessReason = "Owner access to private file"
      } else {
        accessReason = "Access denied - private file, not owner or admin"
      }
    } else if (document.accessLevel === "protected") {
      if (pin) {
        try {
          if (!document.accessPin) {
            console.log("❌ Protected file has no PIN set")
            return res.status(500).json({
              message: "Protected file configuration error - no PIN set",
              error: "MISSING_PIN_HASH",
            })
          }

          const isValidPin = await bcrypt.compare(pin, document.accessPin)
          if (isValidPin) {
            hasAccess = true
            accessReason = "Valid PIN provided for protected file"
          } else {
            accessReason = "Invalid PIN provided"
          }
        } catch (pinError) {
          console.error("❌ PIN comparison error:", pinError)
          return res.status(500).json({
            message: "PIN verification failed due to server error",
            error: "PIN_VERIFICATION_ERROR",
          })
        }
      } else {
        accessReason = "No PIN provided for protected file"
      }
    }

    console.log("Access check result:", { hasAccess, accessReason })

    if (!hasAccess) {
      if (document.accessLevel === "protected") {
        console.log("🔐 Returning PIN required response")
        return res.status(401).json({
          message: "PIN required for protected document",
          requiresPin: true,
        })
      } else if (document.accessLevel === "private") {
        console.log("🔒 Returning access denied response")
        return res.status(403).json({
          message: "Access denied. This is a private document.",
        })
      }
    }

    console.log("✅ Access granted:", accessReason)

    // Download file from Dropbox
    console.log("📥 Starting Dropbox download...")
    console.log("Dropbox path:", document.dropboxPath)

    let fileBuffer
    try {
      fileBuffer = await downloadFromDropbox(document.dropboxPath)

      if (!fileBuffer) {
        console.log("❌ No file buffer returned from Dropbox")
        return res.status(500).json({
          message: "Failed to retrieve file from Dropbox storage",
          error: "EMPTY_FILE_BUFFER",
        })
      }

      console.log("✅ File downloaded from Dropbox, buffer size:", fileBuffer.length)
    } catch (dropboxError) {
      console.error("❌ Dropbox download error:", {
        message: dropboxError.message,
        status: dropboxError.status,
        path: document.dropboxPath,
        documentId: document._id,
        stack: dropboxError.stack,
      })

      if (dropboxError.message.includes("not found") || dropboxError.status === 409) {
        return res.status(404).json({
          message: "File not found in Dropbox storage. It may have been moved or deleted.",
          details: "Please contact support if this file should exist.",
          error: "DROPBOX_FILE_NOT_FOUND",
        })
      } else if (dropboxError.message.includes("authentication") || dropboxError.status === 401) {
        return res.status(500).json({
          message: "Cloud storage authentication error. Please try again later.",
          details: "Contact support if the problem persists.",
          error: "DROPBOX_AUTH_ERROR",
        })
      } else {
        return res.status(500).json({
          message: "Failed to download file from cloud storage: " + dropboxError.message,
          details: "Please try again or contact support.",
          error: "DROPBOX_DOWNLOAD_ERROR",
        })
      }
    }

    // Update download count
    try {
      document.downloadCount = (document.downloadCount || 0) + 1
      await document.save()
      console.log("✅ Download count updated to:", document.downloadCount)
    } catch (countError) {
      console.error("⚠️ Failed to update download count:", countError)
      // Continue with download even if count update fails
    }

    // Set proper headers for file download
    const filename = encodeURIComponent(document.originalName)
    const mimetype = document.mimetype || "application/octet-stream"

    console.log("📤 Setting response headers:", {
      filename: document.originalName,
      mimetype,
      size: fileBuffer.length,
    })

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
    res.setHeader("Content-Type", mimetype)
    res.setHeader("Content-Length", fileBuffer.length)
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition")

    // Send the file buffer
    res.send(fileBuffer)
    console.log("✅ File sent to client successfully")
    console.log("=== DOWNLOAD REQUEST END ===")
  } catch (error) {
    console.error("❌ DOWNLOAD ROUTE ERROR:", {
      message: error.message,
      stack: error.stack,
      documentId: req.params.id,
      userId: req.user?._id,
      documentInfo: document
        ? {
            id: document._id,
            name: document.originalName,
            accessLevel: document.accessLevel,
            dropboxPath: document.dropboxPath,
          }
        : "Document not loaded",
    })

    if (!res.headersSent) {
      res.status(500).json({
        message: "Download failed due to server error",
        details: process.env.NODE_ENV === "development" ? error.message : "Please try again or contact support.",
        error: "INTERNAL_SERVER_ERROR",
        timestamp: new Date().toISOString(),
      })
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
    console.error("Get versions error:", error)
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

    try {
      // Delete file from Dropbox
      await deleteFromDropbox(document.dropboxPath)
      console.log("File deleted from Dropbox successfully")
    } catch (dropboxError) {
      console.error("Dropbox delete error:", dropboxError)
      // Continue with database deletion even if Dropbox deletion fails
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

    res.json({ message: "Document deleted successfully from both database and Dropbox" })
  } catch (error) {
    console.error("Delete error:", error)
    res.status(500).json({ message: error.message })
  }
})

export default router
