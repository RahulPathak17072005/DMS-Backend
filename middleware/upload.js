import multer from "multer"
import path from "path"
import crypto from "crypto"
import dbx from "../config/dropbox.js"

// Use memory storage instead of disk storage for Dropbox upload
const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|xlsx|xls|ppt|pptx/
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
  const mimetype = allowedTypes.test(file.mimetype)

  if (mimetype && extname) {
    return cb(null, true)
  } else {
    cb(new Error("Invalid file type. Only images, PDFs, and documents are allowed."))
  }
}

// Function to calculate file hash from buffer
export const calculateFileHash = (buffer) => {
  const hash = crypto.createHash("sha256")
  hash.update(buffer)
  return hash.digest("hex")
}

// Function to upload file to Dropbox with better error handling
export const uploadToDropbox = async (fileBuffer, filename, originalName) => {
  try {
    console.log("Starting Dropbox upload for:", originalName)

    // Create a unique filename to avoid conflicts
    const timestamp = Date.now()
    const uniqueFilename = `${timestamp}-${filename}`
    const dropboxPath = `/documents/${uniqueFilename}`

    console.log("Uploading to Dropbox path:", dropboxPath)
    console.log("File buffer size:", fileBuffer.length)

    const response = await dbx.filesUpload({
      path: dropboxPath,
      contents: fileBuffer,
      mode: "add",
      autorename: true,
    })

    console.log("Dropbox upload successful:", response.result)

    return {
      dropboxPath: response.result.path_display,
      dropboxFileId: response.result.id,
      filename: response.result.name,
    }
  } catch (error) {
    console.error("Dropbox upload error details:", {
      message: error.message,
      status: error.status,
      error: error.error,
      response: error.response?.data || error.response,
    })

    // Provide more specific error messages
    if (error.status === 401) {
      throw new Error("Dropbox authentication failed. Please check your access token.")
    } else if (error.status === 403) {
      throw new Error("Dropbox access denied. Please check your app permissions.")
    } else if (error.status === 429) {
      throw new Error("Dropbox rate limit exceeded. Please try again later.")
    } else {
      throw new Error(`Dropbox upload failed: ${error.message}`)
    }
  }
}

// Function to download file from Dropbox with better error handling
export const downloadFromDropbox = async (dropboxPath) => {
  try {
    console.log("  📥 Starting Dropbox download...")
    console.log("    - Path:", dropboxPath)

    if (!dropboxPath) {
      throw new Error("Dropbox path is required")
    }

    // Ensure path starts with /
    const normalizedPath = dropboxPath.startsWith("/") ? dropboxPath : `/${dropboxPath}`
    console.log("    - Normalized Path:", normalizedPath)

    // Import Dropbox client
    let dbxClient
    try {
      dbxClient = (await import("../config/dropbox.js")).default
      console.log("    ✅ Dropbox client imported successfully")
    } catch (importError) {
      console.error("    ❌ Failed to import Dropbox client:", importError)
      throw new Error("Failed to initialize Dropbox client: " + importError.message)
    }

    // Test connection first
    console.log("    🔗 Testing Dropbox connection...")
    try {
      const accountInfo = await dbxClient.usersGetCurrentAccount()
      console.log("    ✅ Connection test successful")
      console.log("      - Account:", accountInfo.result.name.display_name)
    } catch (connectionError) {
      console.error("    ❌ Connection test failed:", connectionError)
      throw new Error("Dropbox connection failed: " + connectionError.message)
    }

    // Attempt file download
    console.log("    📁 Attempting file download...")
    const response = await dbxClient.filesDownload({ path: normalizedPath })

    if (!response) {
      console.error("    ❌ No response from Dropbox API")
      throw new Error("No response from Dropbox API")
    }

    if (!response.result) {
      console.error("    ❌ No result in Dropbox response")
      throw new Error("Invalid response structure from Dropbox")
    }

    const fileBuffer = response.result.fileBinary
    if (!fileBuffer) {
      console.error("    ❌ No file binary in response")
      throw new Error("No file data returned from Dropbox")
    }

    console.log("    ✅ Dropbox download successful")
    console.log("      - File Name:", response.result.name)
    console.log("      - File Size:", fileBuffer.length, "bytes")
    console.log("      - Path Display:", response.result.path_display)
    console.log("      - Content Hash:", response.result.content_hash?.substring(0, 10) + "...")

    return fileBuffer
  } catch (error) {
    console.error("  ❌ Dropbox download error:")
    console.error("    - Message:", error.message)
    console.error("    - Status:", error.status)
    console.error("    - Error Summary:", error.error?.error_summary)
    console.error("    - Path:", dropboxPath)

    if (error.status === 409) {
      // File not found
      const errorDetails = error.error?.error?.[".tag"] || "file_not_found"
      throw new Error(`File not found in Dropbox: ${errorDetails}`)
    } else if (error.status === 401) {
      // Authentication error
      throw new Error("Dropbox authentication failed - invalid or expired token")
    } else if (error.status === 429) {
      // Rate limit
      throw new Error("Dropbox rate limit exceeded. Please try again later.")
    } else if (error.message.includes("network") || error.code === "ENOTFOUND") {
      // Network error
      throw new Error("Network error connecting to Dropbox")
    } else if (error.message.includes("connection")) {
      // Connection error
      throw new Error("Failed to connect to Dropbox: " + error.message)
    } else {
      throw new Error(`Dropbox download failed: ${error.message}`)
    }
  }
}

// Function to delete file from Dropbox with better error handling
export const deleteFromDropbox = async (dropboxPath) => {
  try {
    console.log("Deleting from Dropbox path:", dropboxPath)

    await dbx.filesDeleteV2({ path: dropboxPath })
    console.log("Dropbox delete successful")

    return true
  } catch (error) {
    console.error("Dropbox delete error:", error)

    if (error.status === 409) {
      console.warn("File not found in Dropbox for deletion")
      return true // Consider it successful if file doesn't exist
    } else {
      throw new Error(`Dropbox delete failed: ${error.message}`)
    }
  }
}

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: fileFilter,
})
