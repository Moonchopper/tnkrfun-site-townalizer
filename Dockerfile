FROM nginx:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY istoletha/ /usr/share/nginx/istoletha
# site/ (the tnkrfun alien page) is intentionally not copied — it is not served.
# See nginx/default.conf.
