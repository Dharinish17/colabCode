const mongoose = require('mongoose');
const { SUPPORTED_LANGUAGES } = require('../constants/languages');

const roomFileSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    language: {
      type: String,
      required: true,
      enum: SUPPORTED_LANGUAGES,
      default: 'javascript',
    },
    content: {
      type: String,
      default: '',
      maxlength: 100000,
    },
    version: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { timestamps: true },
);

const accessRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const roomSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 60,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    visibility: {
      type: String,
      enum: ['public', 'private'],
      required: true,
      default: 'public',
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    members: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    memberRoles: {
      type: Map,
      of: {
        type: String,
        enum: ['moderator', 'member'],
        default: 'member',
      },
      default: () => new Map(),
    },
    maxMembers: {
      type: Number,
      min: 2,
      max: 50,
      default: 10,
    },
    settings: {
      defaultLanguage: {
        type: String,
        enum: SUPPORTED_LANGUAGES,
        default: 'javascript',
      },
      allowGuests: {
        type: Boolean,
        default: false,
      },
      allowMemberEdits: {
        type: Boolean,
        default: true,
      },
    },
    voicePermissions: {
      membersCanSpeak: {
        type: Boolean,
        default: true,
      },
      memberOverrides: {
        type: Map,
        of: Boolean,
        default: () => new Map(),
      },
    },
    files: {
      type: [roomFileSchema],
      default: () => [{ name: 'main.js', language: 'javascript', content: '' }],
    },
    accessRequests: {
      type: [accessRequestSchema],
      default: () => [],
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

roomSchema.index({ visibility: 1, createdAt: -1 });
roomSchema.index({ members: 1 });

module.exports = mongoose.model('Room', roomSchema);
