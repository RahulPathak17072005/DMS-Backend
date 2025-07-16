import mongoose from "mongoose"

const documentSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true,
    },
    originalName: {
      type: String,
      required: true,
    },
    mimetype: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    // Changed from local path to Dropbox path
    dropboxPath: {
      type: String,
      required: true,
    },
    dropboxFileId: {
      type: String,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    category: {
      type: String,
      enum: ["document", "image", "pdf", "other"],
      default: "other",
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    description: {
      type: String,
      maxlength: 500,
    },
    // Access Control
    accessLevel: {
      type: String,
      enum: ["public", "private", "protected"],
      default: "private",
    },
    accessPin: {
      type: String,
      required: function () {
        return this.accessLevel === "protected"
      },
    },
    // Version Control
    baseFileName: {
      type: String,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
    },
    isLatestVersion: {
      type: Boolean,
      default: true,
    },
    parentDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      default: null,
    },
    versionHistory: [
      {
        version: Number,
        documentId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Document",
        },
        uploadDate: Date,
        uploadedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],
    downloadCount: {
      type: Number,
      default: 0,
    },
    // Additional metadata
    fileHash: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
)

// Index for efficient querying
documentSchema.index({ baseFileName: 1, version: -1 })
documentSchema.index({ uploadedBy: 1 })
documentSchema.index({ accessLevel: 1 })
documentSchema.index({ isLatestVersion: 1 })

export default mongoose.model("Document", documentSchema)
