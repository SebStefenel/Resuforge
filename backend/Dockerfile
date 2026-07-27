# TeX Live is huge (~5GB) but guarantees any LaTeX package a resume template
# might reach for is already present — no first-compile package-download wait
# like the local MiKTeX setup has.
#
# Node 22, not 20: Node 20 is past end-of-life. Changing this tag invalidates
# the texlive layer below, so expect a full ~20min rebuild when you bump it.
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends texlive-full \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
