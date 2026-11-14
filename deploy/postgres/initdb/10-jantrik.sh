#!/bin/sh
# The production Postgres runs this once, on an empty volume (/docker-entrypoint-initdb.d): the
# roles and the database from create-roles.sh, with the passwords of its environment.
sh /jantrik/postgres/create-roles.sh
