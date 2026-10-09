const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    senderUsername: {
      type: String,
      required: true,
      maxlength: 30,
    },
    body: {
      type: String,
      required: true,
      maxlength: 2000,
    },
  },
  { timestamps: true },
);

chatMessageSchema.index({ room: 1, _id: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
