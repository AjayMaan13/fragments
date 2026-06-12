# Multi-stage Dockerfile for the fragments node.js microservice
# Stage 1 installs only production dependencies, Stage 2 builds the final,
# smaller runtime image that contains just what we need to run the server.

###############################################################################
# Stage 1: install production dependencies
###############################################################################
# Use a specific, slim node version to keep the image small and reproducible
FROM node:22.22.2-slim AS dependencies

LABEL maintainer="Ajay <ajayapsmaanm13@gmail.com>"
LABEL description="Fragments node.js microservice"

# Reduce npm spam and disable colour when installing within Docker
ENV NPM_CONFIG_LOGLEVEL=warn
ENV NPM_CONFIG_COLOR=false

WORKDIR /app

# Copy package files first so this layer is cached unless they change
COPY package*.json ./

# Install ONLY production dependencies using the lock file (reproducible build)
RUN npm ci --omit=dev

###############################################################################
# Stage 2: production runtime image
###############################################################################
FROM node:22.22.2-slim AS production

# Run in production mode
ENV NODE_ENV=production

# We default to use port 8080 in our service
ENV PORT=8080

WORKDIR /app

# Copy the installed production node_modules from the dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy package files (needed by npm start / for metadata)
COPY package*.json ./

# Copy our source code
COPY ./src ./src

# Copy our HTPASSWD file
COPY ./tests/.htpasswd ./tests/.htpasswd

# We run our service on port 8080
EXPOSE 8080

# Start the container by running our server (exec/JSON form for proper signals)
CMD ["node", "src/index.js"]
