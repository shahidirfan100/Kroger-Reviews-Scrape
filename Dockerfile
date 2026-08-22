FROM apify/actor-node-playwright-chrome:22

COPY --chown=myuser:myuser package*.json Dockerfile ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && node -e "import('patchright').then(m => console.log('patchright OK:', Boolean(m.chromium)))" \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

USER myuser

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
