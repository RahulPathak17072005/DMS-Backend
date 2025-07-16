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
    console.log("Downloading from Dropbox path:", dropboxPath)

    const response = await dbx.filesDownload({ path: dropboxPath })
    console.log("Dropbox download successful")

    return response.result.fileBinary
  } catch (error) {
    console.error("Dropbox download error:", error)

    if (error.status === 409) {
      throw new Error("File not found in Dropbox")
    } else if (error.status === 401) {
      throw new Error("Dropbox authentication failed")
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
