# Container de backup: tem pg_dump/pg_restore da mesma versão do banco.
FROM postgres:16-alpine
COPY backup.sh /usr/local/bin/nexo-backup
RUN chmod +x /usr/local/bin/nexo-backup
ENTRYPOINT ["nexo-backup"]
CMD ["backup"]
