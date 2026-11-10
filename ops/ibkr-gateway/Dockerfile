# IBKR Client Portal Gateway, for the app's `ibweb` platform (docs/INSTALL.md 4.10).
#
# The gateway is IBKR's own Java program; this image only downloads it and
# runs it. It holds the brokerage session after you sign in from a browser,
# and the app talks to it over HTTPS on port 5000.
FROM eclipse-temurin:17-jre

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/clientportal
RUN curl -fsSL -o gw.zip https://download2.interactivebrokers.com/portal/clientportal.gw.zip \
    && unzip -q gw.zip \
    && rm gw.zip

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5000
ENTRYPOINT ["/entrypoint.sh"]
