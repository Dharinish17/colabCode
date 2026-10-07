const mongoose = require('mongoose');

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
    maxMembers: {
      type: Number,
      min: 2,
      max: 50,
      default: 10,
    },
  },
  { timestamps: true },
);

roomSchema.index({ visibility: 1, createdAt: -1 });
roomSchema.index({ members: 1 });

module.exports = mongoose.model('Room', roomSchema);
