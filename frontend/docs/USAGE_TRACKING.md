# Usage Tracking System

## Overview

The usage tracking system monitors and records token consumption per user in Redis. It tracks `prompt_tokens`, `completion_tokens`, and `total_tokens` for each user's interactions with the chat API.

## Architecture

### Components

1. **Usage Tracking Utility** (`utils/usage/tracking.ts`)
   - Core functions for tracking and retrieving usage statistics
   - Redis integration for persistent storage
   - Automatic daily and monthly aggregation

2. **API Endpoints**
   - `POST /api/usage/track` - Track usage for a user
   - `GET /api/usage/stats` - Retrieve usage statistics

3. **Chat Integration** (`pages/api/chat.ts`)
   - Automatically extracts usage data from backend responses
   - Sends usage data to tracking endpoint

## Data Structure

### UserUsageStats

```typescript
interface UserUsageStats {
  username: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  request_count: number;
  first_request_at: number;
  last_request_at: number;
  daily_usage: Record<string, UsageData>;  // Date (YYYY-MM-DD) -> usage
  monthly_usage: Record<string, UsageData>; // Month (YYYY-MM) -> usage
}
```

### UsageData

```typescript
interface UsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

## Redis Storage

Usage statistics are stored in Redis using the following key pattern:

```
usage:user:<username>
```

Example:
```
usage:user:john_doe
```

The data is stored as JSON using Redis JSON module commands.

## API Usage

### Track Usage

**Endpoint:** `POST /api/usage/track`

**Request Body:**
```json
{
  "username": "john_doe",
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 200,
    "total_tokens": 350
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Usage tracked successfully"
}
```

### Get User Statistics

**Endpoint:** `GET /api/usage/stats?username=<username>`

**Query Parameters:**
- `username` (optional) - Get stats for specific user (defaults to current user)
- `all=true` (optional) - Get all users' stats (admin only)

**Response:**
```json
{
  "success": true,
  "data": {
    "username": "john_doe",
    "total_prompt_tokens": 15000,
    "total_completion_tokens": 20000,
    "total_tokens": 35000,
    "request_count": 100,
    "first_request_at": 1672531200000,
    "last_request_at": 1704067200000,
    "daily_usage": {
      "2025-09-30": {
        "prompt_tokens": 150,
        "completion_tokens": 200,
        "total_tokens": 350
      }
    },
    "monthly_usage": {
      "2025-09": {
        "prompt_tokens": 5000,
        "completion_tokens": 6000,
        "total_tokens": 11000
      }
    }
  }
}
```

## Automatic Tracking

Usage tracking is automatically integrated into the chat API. When a user sends a message:

1. The chat request is sent to the backend with the username in the `x-user-id` header
2. The backend processes the request and returns usage data in the response
3. The chat API extracts the usage data from the response
4. Usage is automatically tracked via the `/api/usage/track` endpoint

### Streaming Responses

For streaming responses, usage data is typically included in the final response chunk or after the `[DONE]` marker. The system extracts this data and tracks it automatically.

### Non-Streaming Responses

For non-streaming responses, usage data is extracted from the `usage` field in the response JSON.

## Utility Functions

### Track User Usage

```typescript
import { trackUserUsage } from '@/utils/usage/tracking';

await trackUserUsage('john_doe', {
  prompt_tokens: 150,
  completion_tokens: 200,
  total_tokens: 350
});
```

### Get User Statistics

```typescript
import { getUserUsageStats } from '@/utils/usage/tracking';

const stats = await getUserUsageStats('john_doe');
console.log(stats);
```

### Get All Users' Statistics

```typescript
import { getAllUsageStats } from '@/utils/usage/tracking';

const allStats = await getAllUsageStats();
console.log(allStats);
```

### Reset User Statistics

```typescript
import { resetUserUsageStats } from '@/utils/usage/tracking';

await resetUserUsageStats('john_doe');
```

### Clean Up Old Data

```typescript
import { cleanupOldUsageData } from '@/utils/usage/tracking';

// Removes daily usage data older than 90 days
await cleanupOldUsageData('john_doe');
```

## Data Retention

- **Daily Usage:** Stored per day (YYYY-MM-DD format)
- **Monthly Usage:** Stored per month (YYYY-MM format)
- **Cleanup:** The `cleanupOldUsageData` function removes daily usage data older than 90 days

## Security

- Users can only view their own usage statistics
- Admin users can view all users' statistics (requires admin role check)
- Usage tracking endpoint is internal and does not require authentication (called from trusted API routes)

## Monitoring

Usage data is logged to the console:

```
Usage tracked for user john_doe: 350 tokens
```

Failed tracking attempts are also logged:

```
Failed to track usage: <error details>
```

## Implementation Notes

1. **Edge Runtime Compatibility:** The chat API uses Edge runtime, so usage tracking is done via HTTP requests to a Node.js API route that has full Redis access.

2. **Fire and Forget:** Usage tracking is implemented as a fire-and-forget operation to avoid blocking the chat response stream.

3. **Error Handling:** Tracking failures are logged but do not interrupt the chat flow.

4. **Aggregation:** Usage is automatically aggregated at daily and monthly levels for efficient querying.

## Future Enhancements

Possible improvements to the usage tracking system:

1. **Rate Limiting:** Implement per-user rate limits based on token usage
2. **Usage Alerts:** Send notifications when users exceed certain thresholds
3. **Cost Tracking:** Calculate costs based on token usage and model pricing
4. **Analytics Dashboard:** Create a UI for visualizing usage statistics
5. **Export Functionality:** Allow exporting usage data to CSV or JSON
6. **Billing Integration:** Integrate with billing systems for usage-based pricing
