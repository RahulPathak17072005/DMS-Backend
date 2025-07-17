import { Dropbox } from "dropbox"
import dotenv from "dotenv"

dotenv.config()

// Configure Dropbox client with proper error handling
const createDropboxClient = () => {
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN

  if (!accessToken) {
    console.error("❌ DROPBOX_ACCESS_TOKEN is not set in environment variables")
    throw new Error("Dropbox access token is required")
  }

  try {
    const dbx = new Dropbox({
      accessToken: accessToken,
      fetch: fetch, // Use native fetch
    })

    console.log("✅ Dropbox client initialized successfully")

    // Test the connection
    dbx
      .usersGetCurrentAccount()
      .then((response) => {
        console.log("✅ Dropbox connection verified for user:", response.result.name.display_name)
      })
      .catch((error) => {
        console.error("❌ Dropbox connection test failed:", error.message)
      })

    return dbx
  } catch (error) {
    console.error("❌ Failed to initialize Dropbox client:", error)
    throw error
  }
}

const dbx = createDropboxClient()

export default dbx
