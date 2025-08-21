FROM node:18-alpine

WORKDIR /app

# Install nmap if available for better discovery
# We use a multi-stage build to keep the final image small if nmap is not needed
RUN apk add --no-cache nmap || echo "nmap not found, continuing without it"

COPY package.json ./ 
RUN npm install --production

COPY . .

CMD ["npm", "start"]
