/*
  Azure Cache for Redis (EXPD-007).

  Nothing reads it yet. It is here because the things that will are already
  written down: the realtime channel (EXPD-023) needs somewhere to fan an
  event out from that is not one web app's memory, and the leaderboard
  (EXPD-022) needs somewhere to hold a running score that is not a table it
  would have to recompute per request.

  TLS only. The non-TLS port is off, so a client that forgets `rediss://`
  fails to connect rather than succeeding in clear.
*/

@description('The cache name. Globally unique.')
param name string

@description('Azure region.')
param location string

@description('Tags for the cache.')
param tags object

@description('Which Redis tier.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string

@description('SKU family: C for Basic and Standard, P for Premium.')
@allowed([
  'C'
  'P'
])
param family string

@description('Size within the family. 0 is the smallest C.')
param capacity int

resource cache 'Microsoft.Cache/redis@2024-11-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: skuName
      family: family
      capacity: capacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    redisConfiguration: {
      // Evict the least recently used key when the cache fills, rather than
      // refusing writes. Everything here is either a cache or a live event
      // somebody has already been shown; none of it is the record.
      'maxmemory-policy': 'allkeys-lru'
    }
  }
}

@description('The host to connect to.')
output hostName string = cache.properties.hostName

@description('The TLS port.')
output sslPort int = cache.properties.sslPort

@description('The cache\'s name.')
output name string = cache.name

@description('The cache\'s resource id.')
output id string = cache.id
