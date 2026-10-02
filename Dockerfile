FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json Dockerfile ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
    && node -e "import('impit').then(m => console.log('impit OK:', Boolean(m.Impit)))" \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

USER myuser

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
