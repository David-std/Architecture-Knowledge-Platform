delete from api_tokens
 where label='local development'
    or token_hash='1734d503f6aa6a047c36d113cbad769f719c93784b469b771c4c3e7c63adbefd';
