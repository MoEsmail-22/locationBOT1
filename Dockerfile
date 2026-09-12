FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app source
COPY . .

# Start the bot
CMD ["npm", "start"]
