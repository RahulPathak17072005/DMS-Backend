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

// Simple download test endpoint - just returns file info without downloading
router.get("/download-test/:id", authenticate, async (req, res) => {
  try {
    console.log("🧪 SIMPLE DOWNLOAD TEST - Document ID:", req.params.id)

    // Find document
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      return res.status(404).json({
        success: false,
        error: "Document not found",
        documentId: req.params.id,
      })
    }

    console.log("✅ Document found:", document.originalName)

    // Check basic access
    let hasAccess = false
    if (document.accessLevel === "public") {
      hasAccess = true
    } else if (document.accessLevel === "private") {
      hasAccess = req.user.role === "admin" || document.uploadedBy._id.toString() === req.user._id.toString()
    }

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
      })
    }

    // Test Dropbox connection only
    try {
      const dbx = (await import("../config/dropbox.js")).default
      await dbx.usersGetCurrentAccount()
      console.log("✅ Dropbox connection OK")
    } catch (dbxError) {
      console.error("❌ Dropbox connection failed:", dbxError)
      return res.status(500).json({
        success: false,
        error: "Dropbox connection failed: " + dbxError.message,
      })
    }

    // Return success without actually downloading
    res.json({
      success: true,
      message: "Download test passed - ready for actual download",
      document: {
        id: document._id,
        name: document.originalName,
        size: document.size,
        path: document.dropboxPath,
        accessLevel: document.accessLevel,
      },
      user: {
        id: req.user._id,
        role: req.user.role,
      },
    })
  } catch (error) {
    console.error("❌ Download test error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
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

// NEW: Preview endpoint for file viewing before download
router.get("/preview/:id", authenticate, async (req, res) => {
  try {
    console.log("👁️ =================================")
    console.log("👁️ PREVIEW REQUEST STARTED")
    console.log("👁️ Document ID:", req.params.id)
    console.log("👁️ User:", req.user?.email, "Role:", req.user?.role)
    console.log("👁️ =================================")

    // Find document
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      console.log("❌ Document not found")
      return res.status(404).json({
        message: "Document not found",
        error: "NOT_FOUND",
      })
    }

    console.log("📄 Preview document:", document.originalName)
    console.log("📄 File type:", document.mimetype)
    console.log("📄 Access level:", document.accessLevel)

    // Check access permissions (same as download)
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
      console.log("❌ Preview access denied:", accessReason)
      if (document.accessLevel === "protected" && !pin) {
        return res.status(401).json({
          message: "PIN required for protected document",
          requiresPin: true,
          error: "PIN_REQUIRED",
        })
      }
      return res.status(403).json({
        message: "Access denied: " + accessReason,
        error: "ACCESS_DENIED",
      })
    }

    console.log("✅ Preview access granted:", accessReason)

    // Download file from Dropbox
    console.log("📥 Downloading file from Dropbox for preview...")
    const fileBuffer = await downloadFromDropbox(document.dropboxPath)

    if (!fileBuffer || fileBuffer.length === 0) {
      console.log("❌ Empty file received from Dropbox")
      return res.status(500).json({
        message: "Empty file received from Dropbox",
        error: "EMPTY_FILE",
      })
    }

    console.log("✅ File downloaded for preview, size:", fileBuffer.length)

    // Set appropriate headers for preview
    res.setHeader("Content-Type", document.mimetype || "application/octet-stream")
    res.setHeader("Content-Length", fileBuffer.length)
    res.setHeader("Cache-Control", "private, max-age=3600") // Cache for 1 hour

    // For PDFs and images, allow inline viewing
    if (document.mimetype === "application/pdf" || document.mimetype.startsWith("image/")) {
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.originalName)}`)
      console.log("📄 Set headers for inline viewing (PDF/Image)")
    } else {
      // For text files, also allow inline
      if (
        document.mimetype.includes("text/") ||
        document.originalName.toLowerCase().endsWith(".txt") ||
        document.originalName.toLowerCase().endsWith(".json") ||
        document.originalName.toLowerCase().endsWith(".csv") ||
        document.originalName.toLowerCase().endsWith(".md")
      ) {
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(document.originalName)}`)
        res.setHeader("Content-Type", "text/plain; charset=utf-8")
        console.log("📝 Set headers for text file viewing")
      } else {
        // For other files, suggest download
        res.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
        )
        console.log("📎 Set headers for download (unsupported preview)")
      }
    }

    res.send(fileBuffer)
    console.log("✅ Preview sent successfully!")
    console.log("👁️ =================================")
  } catch (error) {
    console.error("❌ Preview error:", error)

    if (error.message.includes("Dropbox")) {
      res.status(500).json({
        message: "Cloud storage error: " + error.message,
        error: "DROPBOX_ERROR",
      })
    } else {
      res.status(500).json({
        message: "Preview failed: " + error.message,
        error: "PREVIEW_ERROR",
      })
    }
  }
})

// Add a debug endpoint to test preview functionality
router.get("/debug-preview/:id", authenticate, async (req, res) => {
  try {
    console.log("🐛 DEBUG PREVIEW - Document ID:", req.params.id)

    // Find document
    const document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")

    if (!document) {
      return res.json({
        success: false,
        error: "Document not found",
        documentId: req.params.id,
      })
    }

    // Test file download
    let fileBuffer
    let downloadError = null
    try {
      fileBuffer = await downloadFromDropbox(document.dropboxPath)
    } catch (error) {
      downloadError = error.message
    }

    res.json({
      success: true,
      document: {
        id: document._id,
        name: document.originalName,
        mimetype: document.mimetype,
        size: document.size,
        accessLevel: document.accessLevel,
        dropboxPath: document.dropboxPath,
      },
      file: {
        downloaded: !!fileBuffer,
        actualSize: fileBuffer ? fileBuffer.length : 0,
        expectedSize: document.size,
        sizeMatch: fileBuffer ? fileBuffer.length === document.size : false,
        downloadError: downloadError,
      },
      previewSupported: {
        isImage: document.mimetype && document.mimetype.startsWith("image/"),
        isPDF: document.mimetype === "application/pdf",
        isText: document.mimetype && document.mimetype.includes("text/"),
        mimetype: document.mimetype,
      },
    })
  } catch (error) {
    console.error("Debug preview error:", error)
    res.status(500).json({
      success: false,
      error: error.message,
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
  // Wrap everything in try-catch to prevent server crashes
  try {
    console.log("🚀 =================================")
    console.log("🚀 DOWNLOAD REQUEST STARTED")
    console.log("🚀 Document ID:", req.params.id)
    console.log("🚀 User:", req.user?.email, "Role:", req.user?.role)
    console.log("🚀 Timestamp:", new Date().toISOString())
    console.log("🚀 =================================")

    // Step 1: Basic validation
    if (!req.params.id || req.params.id.length !== 24) {
      console.log("❌ STEP 1 FAILED: Invalid document ID format")
      return res.status(400).json({
        message: "Invalid document ID format",
        error: "INVALID_ID",
        step: "validation",
      })
    }
    console.log("✅ STEP 1 PASSED: Document ID format valid")

    // Step 2: Find document
    console.log("📊 STEP 2: Finding document in database...")
    let document
    try {
      document = await Document.findById(req.params.id).populate("uploadedBy", "username email _id")
    } catch (dbError) {
      console.log("❌ STEP 2 FAILED: Database error:", dbError.message)
      return res.status(500).json({
        message: "Database error while finding document",
        error: "DATABASE_ERROR",
        step: "find_document",
        details: dbError.message,
      })
    }

    if (!document) {
      console.log("❌ STEP 2 FAILED: Document not found")
      return res.status(404).json({
        message: "Document not found",
        error: "NOT_FOUND",
        step: "find_document",
      })
    }

    console.log("✅ STEP 2 PASSED: Document found")
    console.log("📋 Document details:")
    console.log("  - Name:", document.originalName)
    console.log("  - Access Level:", document.accessLevel)
    console.log("  - Size:", document.size)
    console.log("  - Dropbox Path:", document.dropboxPath)
    console.log("  - Uploaded By:", document.uploadedBy?.username)

    // Step 3: Check access permissions
    console.log("🔐 STEP 3: Checking access permissions...")
    const { pin } = req.query
    let hasAccess = false
    let accessReason = ""

    try {
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
    } catch (accessError) {
      console.log("❌ STEP 3 FAILED: Access check error:", accessError.message)
      return res.status(500).json({
        message: "Error checking access permissions",
        error: "ACCESS_CHECK_ERROR",
        step: "access_check",
        details: accessError.message,
      })
    }

    console.log("🔐 Access check result:", hasAccess, "-", accessReason)

    if (!hasAccess) {
      console.log("❌ STEP 3 FAILED: Access denied")
      if (document.accessLevel === "protected" && !pin) {
        return res.status(401).json({
          message: "PIN required for protected document",
          requiresPin: true,
          error: "PIN_REQUIRED",
          step: "access_check",
        })
      }
      return res.status(403).json({
        message: "Access denied: " + accessReason,
        error: "ACCESS_DENIED",
        step: "access_check",
      })
    }
    console.log("✅ STEP 3 PASSED: Access granted")

    // Step 4: Test Dropbox connection
    console.log("☁️ STEP 4: Testing Dropbox connection...")
    let dbx
    try {
      dbx = (await import("../config/dropbox.js")).default
      await dbx.usersGetCurrentAccount()
      console.log("✅ STEP 4 PASSED: Dropbox connection verified")
    } catch (dropboxConnError) {
      console.log("❌ STEP 4 FAILED: Dropbox connection error:", dropboxConnError.message)
      return res.status(500).json({
        message: "Dropbox connection failed",
        error: "DROPBOX_CONNECTION_ERROR",
        step: "dropbox_connection",
        details: dropboxConnError.message,
      })
    }

    // Step 5: Download file from Dropbox
    console.log("📥 STEP 5: Downloading file from Dropbox...")
    console.log("  - Path:", document.dropboxPath)
    let fileBuffer
    try {
      fileBuffer = await downloadFromDropbox(document.dropboxPath)
    } catch (downloadError) {
      console.log("❌ STEP 5 FAILED: Dropbox download error:", downloadError.message)
      return res.status(500).json({
        message: "Failed to download file from Dropbox",
        error: "DROPBOX_DOWNLOAD_ERROR",
        step: "dropbox_download",
        details: downloadError.message,
      })
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      console.log("❌ STEP 5 FAILED: Empty file received")
      return res.status(500).json({
        message: "Empty file received from Dropbox",
        error: "EMPTY_FILE",
        step: "dropbox_download",
      })
    }

    console.log("✅ STEP 5 PASSED: File downloaded successfully")
    console.log("  - Size:", fileBuffer.length, "bytes")
    console.log("  - Expected:", document.size, "bytes")
    console.log("  - Match:", fileBuffer.length === document.size ? "✅" : "⚠️")

    // Step 6: Update download count
    console.log("📊 STEP 6: Updating download count...")
    try {
      document.downloadCount = (document.downloadCount || 0) + 1
      await document.save()
      console.log("✅ STEP 6 PASSED: Download count updated to:", document.downloadCount)
    } catch (countError) {
      console.warn("⚠️ STEP 6 WARNING: Failed to update download count:", countError.message)
      // Don't fail the download for this
    }

    // Step 7: Send file to client
    console.log("📤 STEP 7: Sending file to client...")
    try {
      const filename = encodeURIComponent(document.originalName)

      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
      res.setHeader("Content-Type", document.mimetype || "application/octet-stream")
      res.setHeader("Content-Length", fileBuffer.length)
      res.setHeader("Cache-Control", "no-cache")

      res.send(fileBuffer)
      console.log("✅ STEP 7 PASSED: File sent successfully!")
      console.log("🎉 DOWNLOAD COMPLETED SUCCESSFULLY!")
    } catch (sendError) {
      console.log("❌ STEP 7 FAILED: Error sending file:", sendError.message)
      if (!res.headersSent) {
        return res.status(500).json({
          message: "Error sending file to client",
          error: "SEND_ERROR",
          step: "send_file",
          details: sendError.message,
        })
      }
    }
  } catch (criticalError) {
    console.error("💥 CRITICAL ERROR in download route:", {
      message: criticalError.message,
      name: criticalError.name,
      stack: criticalError.stack,
      documentId: req.params.id,
      userId: req.user?._id,
      timestamp: new Date().toISOString(),
    })

    if (!res.headersSent) {
      res.status(500).json({
        message: "Critical server error during download",
        error: "CRITICAL_ERROR",
        step: "unknown",
        details: criticalError.message,
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
