import multer from "multer"
import path from "path"
import crypto from "crypto"

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

    // Import Dropbox client with error handling
    let dbx
    try {
      dbx = (await import("../config/dropbox.js")).default
    } catch (importError) {
      throw new Error("Failed to initialize Dropbox client: " + importError.message)
    }

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

// Function to download file from Dropbox with SDK compatibility fix
export const downloadFromDropbox = async (dropboxPath) => {
  try {
    console.log("📥 Starting Dropbox download for path:", dropboxPath)

    if (!dropboxPath) {
      throw new Error("Dropbox path is required")
    }

    // Ensure path starts with /
    const normalizedPath = dropboxPath.startsWith("/") ? dropboxPath : `/${dropboxPath}`

    // Import Dropbox client with error handling
    let dbxClient
    try {
      dbxClient = (await import("../config/dropbox.js")).default
    } catch (importError) {
      throw new Error("Failed to initialize Dropbox client: " + importError.message)
    }

    // Test connection first
    try {
      await dbxClient.usersGetCurrentAccount()
      console.log("✅ Dropbox connection verified")
    } catch (connectionError) {
      throw new Error("Dropbox connection failed: " + connectionError.message)
    }

    // Method 1: Try the standard filesDownload (this might fail with the buffer error)
    try {
      console.log("🔄 Attempting standard filesDownload...")
      const response = await dbxClient.filesDownload({ path: normalizedPath })
      
      if (response && response.result && response.result.fileBinary) {
        let fileContent = response.result.fileBinary
        
        // Convert to Buffer if needed
        if (Buffer.isBuffer(fileContent)) {
          console.log("✅ Got Buffer directly from filesDownload, size:", fileContent.length)
          return fileContent
        } else if (fileContent instanceof Uint8Array) {
          console.log("✅ Converting Uint8Array to Buffer, size:", fileContent.length)
          return Buffer.from(fileContent)
        } else if (fileContent instanceof ArrayBuffer) {
          console.log("✅ Converting ArrayBuffer to Buffer, size:", fileContent.byteLength)
          return Buffer.from(fileContent)
        }
      }
    } catch (downloadError) {
      console.log("⚠️ Standard filesDownload failed:", downloadError.message)
      
      // If it's the buffer error, try alternative method
      if (downloadError.message.includes("res.buffer is not a function")) {
        console.log("🔄 Trying alternative download method...")
        
        // Method 2: Use a raw HTTP request to bypass the SDK's response parsing
        try {
          const fetch = (await import("node-fetch")).default
          
          // Get a temporary download link
          const linkResponse = await dbxClient.filesGetTemporaryLink({ path: normalizedPath })
          
          if (linkResponse && linkResponse.result && linkResponse.result.link) {
            console.log("✅ Got temporary download link")
            
            // Download using fetch
            const fetchResponse = await fetch(linkResponse.result.link)
            
            if (!fetchResponse.ok) {
              throw new Error(`HTTP error! status: ${fetchResponse.status}`)
            }
            
            const arrayBuffer = await fetchResponse.arrayBuffer()
            const fileContent = Buffer.from(arrayBuffer)
            
            console.log("✅ Downloaded via temporary link, size:", fileContent.length)
            return fileContent
          }
        } catch (linkError) {
          console.log("⚠️ Temporary link method failed:", linkError.message)
        }
        
        // Method 3: Try using the sharing API as a fallback
        try {
          console.log("🔄 Trying sharing API method...")
          
          // Create a shared link
          const shareResponse = await dbxClient.sharingCreateSharedLinkWithSettings({
            path: normalizedPath,
            settings: {
              requested_visibility: "public"
            }
          })
          
          if (shareResponse && shareResponse.result && shareResponse.result.url) {
            const sharedUrl = shareResponse.result.url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
            
            const fetch = (await import("node-fetch")).default
            const fetchResponse = await fetch(sharedUrl)
            
            if (!fetchResponse.ok) {
              throw new Error(`HTTP error! status: ${fetchResponse.status}`)
            }
            
            const arrayBuffer = await fetchResponse.arrayBuffer()
            const fileContent = Buffer.from(arrayBuffer)
            
            console.log("✅ Downloaded via shared link, size:", fileContent.length)
            
            // Clean up the shared link
            try {
              await dbxClient.sharingRevokeSharedLink({ url: shareResponse.result.url })
            } catch (cleanupError) {
              console.warn("⚠️ Failed to clean up shared link:", cleanupError.message)
            }
            
            return fileContent
          }
        } catch (shareError) {
          console.log("⚠️ Sharing API method failed:", shareError.message)
        }
      }
      
      // If all methods failed, throw the original error
      throw downloadError
    }

    throw new Error("All download methods failed")

  } catch (error) {
    console.error("❌ Dropbox download error:", {
      message: error.message,
      status: error.status,
      path: dropboxPath,
      stack: error.stack
    })

    if (error.status === 409) {
      throw new Error("File not found in Dropbox")
    } else if (error.status === 401) {
      throw new Error("Dropbox authentication failed")
    } else if (error.status === 429) {
      throw new Error("Dropbox rate limit exceeded")
    } else if (error.message.includes("network") || error.code === "ENOTFOUND") {
      throw new Error("Network error connecting to Dropbox")
    } else {
      throw new Error(`Dropbox download failed: ${error.message}`)
    }
  }
}

// Alternative: Monkey patch the Dropbox SDK to fix the buffer issue
export const initializeDropboxWithBufferFix = async () => {
  try {
    // This is a workaround for the res.buffer is not a function issue
    const originalFetch = global.fetch
    
    if (originalFetch) {
      global.fetch = async (url, options) => {
        const response = await originalFetch(url, options)
        
        // Add buffer method if it doesn't exist
        if (!response.buffer && response.arrayBuffer) {
          response.buffer = async () => {
            const arrayBuffer = await response.arrayBuffer()
            return Buffer.from(arrayBuffer)
          }
        }
        
        return response
      }
    }
    
    return true
  } catch (error) {
    console.error("Failed to initialize Dropbox buffer fix:", error)
    return false
  }
}

// Function to delete file from Dropbox with better error handling
export const deleteFromDropbox = async (dropboxPath) => {
  try {
    console.log("Deleting from Dropbox path:", dropboxPath)

    // Import Dropbox client
    const dbx = (await import("../config/dropbox.js")).default
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
