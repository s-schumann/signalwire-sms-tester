# Pin the October security release; update this tag and digest together.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
RUN apk add --no-cache --upgrade 'musl>=1.2.6-r3' libgcc libstdc++ ca-certificates-bundle
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && chown -R 1000:1000 /app
# Preserve scanner-visible metadata only for libraries shipped in scratch.
RUN node --input-type=module -e 'import fs from "node:fs"; const names=new Set(["musl","libgcc","libstdc++","ca-certificates-bundle"]); const records=fs.readFileSync("/lib/apk/db/installed","utf8").trim().split("\n\n").filter(record=>names.has(record.match(/^P:(.+)$/m)?.[1])); fs.mkdirSync("/runtime/lib/apk/db",{recursive:true}); fs.writeFileSync("/runtime/lib/apk/db/installed",records.join("\n\n")+"\n\n");'

FROM scratch
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /lib/ld-musl-*.so.1 /lib/
COPY --from=runtime /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=runtime /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime /etc/os-release /etc/alpine-release /etc/
COPY --from=runtime /runtime/ /
COPY --from=runtime --chown=1000:1000 /app /app
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "const http=require('node:http');const r=http.get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/health'},s=>{s.resume();process.exitCode=s.statusCode===200?0:1});r.setTimeout(2000,()=>r.destroy());r.on('error',()=>{process.exitCode=1})"]
CMD ["node", "src/server.js"]
