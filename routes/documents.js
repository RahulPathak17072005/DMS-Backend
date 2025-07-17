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

// Simple health check for documents route
router.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    message: "Documents route is working",
  })
})

// Public endpoint to list all documents (for debugging only)
router.get("/list-all", async (req, res) => {
  try {
    console.log("📋 Listing all documents for debugging")

    // Find all documents in the database
    const documents = await Document.find()
      .select("_id originalName dropboxPath accessLevel size createdAt")
      .sort({ createdAt: -1 })
      .limit(20) // Limit to 20 most recent documents

    if (!documents || documents.length === 0) {
      return res.json({
        success: false,
        message: "No documents found in the database",
        timestamp: new Date().toISOString(),
      })
    }

    res.json({
      success: true,
      count: documents.length,
      documents: documents.map((doc) => ({
        id: doc._id,
        name: doc.originalName,
        path: doc.dropboxPath,
        accessLevel: doc.accessLevel,
        size: doc.size,
        createdAt: doc.createdAt,
      })),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Error listing documents:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Public test endpoint to check document existence (no auth required)
router.get("/test-document/:id", async (req, res) => {
  try {
    console.log("🧪 PUBLIC TEST - Document ID:", req.params.id)

    // Basic ID validation
    if (!req.params.id || req.params.id.length !== 24) {
      return res.json({
        success: false,
        error: "Invalid document ID format",
        documentId: req.params.id,
      })
    }

    // Find document
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      return res.json({
        success: false,
        error: "Document not found",
        documentId: req.params.id,
      })
    }

    // Test Dropbox connection
    let dropboxStatus = "unknown"
    let dropboxError = null

    try {
      const dbx = (await import("../config/dropbox.js")).default
      const accountInfo = await dbx.usersGetCurrentAccount()
      dropboxStatus = "connected"
    } catch (error) {
      dropboxStatus = "failed"
      dropboxError = error.message
    }

    // Test file existence in Dropbox (without downloading)
    let fileExists = false
    let fileError = null
    let fileSize = 0

    try {
      const dbx = (await import("../config/dropbox.js")).default
      const metadata = await dbx.filesGetMetadata({ path: document.dropboxPath })
      fileExists = true
      fileSize = metadata.result.size
    } catch (error) {
      fileError = error.message
    }

    res.json({
      success: true,
      document: {
        id: document._id,
        name: document.originalName,
        size: document.size,
        accessLevel: document.accessLevel,
        dropboxPath: document.dropboxPath,
        uploadedBy: document.uploadedBy?.username,
        createdAt: document.createdAt,
      },
      dropbox: {
        status: dropboxStatus,
        error: dropboxError,
      },
      file: {
        exists: fileExists,
        error: fileError,
        actualSize: fileSize,
        expectedSize: document.size,
        sizeMatch: fileSize === document.size,
      },
    })
  } catch (error) {
    console.error("Public test error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
})

// Test endpoint to check document and Dropbox connectivity (requires auth)
router.get("/test-download/:id", authenticate, async (req, res) => {
  try {
    console.log("🧪 TEST DOWNLOAD ENDPOINT - Document ID:", req.params.id)

    // Find document
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      return res.json({
        success: false,
        error: "Document not found",
        documentId: req.params.id,
      })
    }

    // Test Dropbox connection
    let dropboxStatus = "unknown"
    let dropboxError = null

    try {
      const dbx = (await import("../config/dropbox.js")).default
      const accountInfo = await dbx.usersGetCurrentAccount()
      dropboxStatus = "connected"
    } catch (error) {
      dropboxStatus = "failed"
      dropboxError = error.message
    }

    // Test file existence in Dropbox
    let fileExists = false
    let fileError = null

    try {
      const fileBuffer = await downloadFromDropbox(document.dropboxPath)
      fileExists = fileBuffer && fileBuffer.length > 0
    } catch (error) {
      fileError = error.message
    }

    res.json({
      success: true,
      document: {
        id: document._id,
        name: document.originalName,
        size: document.size,
        accessLevel: document.accessLevel,
        dropboxPath: document.dropboxPath,
        uploadedBy: document.uploadedBy?.username,
      },
      dropbox: {
        status: dropboxStatus,
        error: dropboxError,
      },
      file: {
        exists: fileExists,
        error: fileError,
      },
      user: {
        id: req.user._id,
        role: req.user.role,
        email: req.user.email,
      },
    })
  } catch (error) {
    console.error("Test download error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    })
  }
})

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
  console.log("🚀 Download request started for document:", req.params.id)
  console.log("👤 User:", req.user.email, "Role:", req.user.role)

  try {
    // Basic validation
    if (!req.params.id || req.params.id.length !== 24) {
      console.log("❌ Invalid document ID format")
      return res.status(400).json({
        message: "Invalid document ID format",
        error: "INVALID_ID",
      })
    }

    // Find document
    console.log("📊 Step 1: Finding document...")
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      console.log("❌ Document not found")
      return res.status(404).json({
        message: "Document not found",
        error: "NOT_FOUND",
      })
    }

    console.log("✅ Document found:", document.originalName)
    console.log("📋 Document details:")
    console.log("  - Access Level:", document.accessLevel)
    console.log("  - Size:", document.size)
    console.log("  - Dropbox Path:", document.dropboxPath)
    console.log("  - Uploaded By:", document.uploadedBy?.username)

    // Check access permissions
    console.log("🔐 Step 2: Checking permissions...")
    const { pin } = req.query
    let hasAccess = false
    let accessReason = ""

    if (document.accessLevel === "public") {
      hasAccess = true
      accessReason = "Public file"
    } else if (document.accessLevel === "private") {
      if (req.user.role === "admin") {
        hasAccess = true
        accessReason = "Admin access"
      } else if (document.uploadedBy._id.toString() === req.user._id.toString()) {
        hasAccess = true
        accessReason = "Owner access"
      } else {
        accessReason = "Private file - access denied"
      }
    } else if (document.accessLevel === "protected") {
      if (pin && document.accessPin) {
        const isValidPin = await bcrypt.compare(pin, document.accessPin)
        if (isValidPin) {
          hasAccess = true
          accessReason = "Valid PIN provided"
        } else {
          accessReason = "Invalid PIN"
        }
      } else {
        accessReason = "PIN required"
      }
    }

    console.log("🔐 Access check result:", hasAccess, "-", accessReason)

    if (!hasAccess) {
      if (document.accessLevel === "protected" && !pin) {
        return res.status(401).json({
          message: "PIN required for protected document",
          requiresPin: true,
        })
      }
      return res.status(403).json({
        message: "Access denied: " + accessReason,
        error: "ACCESS_DENIED",
      })
    }

    // Test Dropbox connection
    console.log("☁️ Step 3: Testing Dropbox connection...")
    const dbx = (await import("../config/dropbox.js")).default
    await dbx.usersGetCurrentAccount()
    console.log("✅ Dropbox connection verified")

    // Download file
    console.log("📥 Step 4: Downloading file from Dropbox...")
    console.log("  - Path:", document.dropboxPath)

    const fileBuffer = await downloadFromDropbox(document.dropboxPath)

    if (!fileBuffer || fileBuffer.length === 0) {
      console.log("❌ Empty file received")
      return res.status(500).json({
        message: "Empty file received from Dropbox",
        error: "EMPTY_FILE",
      })
    }

    console.log("✅ File downloaded successfully")
    console.log("  - Size:", fileBuffer.length, "bytes")
    console.log("  - Expected:", document.size, "bytes")
    console.log("  - Match:", fileBuffer.length === document.size ? "✅" : "⚠️")

    // Update download count
    try {
      document.downloadCount = (document.downloadCount || 0) + 1
      await document.save()
      console.log("📊 Download count updated to:", document.downloadCount)
    } catch (countError) {
      console.warn("⚠️ Failed to update download count:", countError.message)
    }

    // Send file
    console.log("📤 Step 5: Sending file to client...")
    const filename = encodeURIComponent(document.originalName)

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
    res.setHeader("Content-Type", document.mimetype || "application/octet-stream")
    res.setHeader("Content-Length", fileBuffer.length)
    res.setHeader("Cache-Control", "no-cache")

    res.send(fileBuffer)
    console.log("✅ Download completed successfully!")
  } catch (error) {
    console.error("❌ Download failed with error:", {
      message: error.message,
      name: error.name,
      documentId: req.params.id,
      userId: req.user._id,
      timestamp: new Date().toISOString(),
    })

    if (!res.headersSent) {
      res.status(500).json({
        message: "Download failed: " + error.message,
        error: "SERVER_ERROR",
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
