FROM node:22-alpine

WORKDIR /app

# Clone the repo
RUN apk add --no-cache git \
    && git clone https://github.com/NeuraiProject/neurai-lock.git . \
    && apk del git

# Install example dependencies (from npmjs)
WORKDIR /app/example
RUN npm install

# Override the default port to 4500
ENV PORT=4500
RUN sed -i 's/const PORT = 4000/const PORT = process.env.PORT || 4000/' server.js

EXPOSE 4500

CMD ["node", "server.js"]
