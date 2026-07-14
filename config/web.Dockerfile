# SMEAG 조회 앱 : PHP 8.2 + Apache + pdo_pgsql (Supabase/Postgres 접속)
# 주의: 레거시 PHP 5.6 은 libpq 구버전이라 Supabase 의 scram-sha-256 인증 불가.
#       → 모던 PHP(8.2)+최신 libpq 로 구동해야 Supabase 에 접속됨.
FROM php:8.2-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq-dev \
 && docker-php-ext-install pdo_pgsql pgsql \
 && a2enmod rewrite \
 && rm -rf /var/lib/apt/lists/*
