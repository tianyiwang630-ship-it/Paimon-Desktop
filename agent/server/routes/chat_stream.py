"""
 APIServer-Sent Events
"""

import asyncio
import json
import threading
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from agent.server.models import ChatRequest

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("/stream")
async def chat_stream(body: ChatRequest, request: Request):
    """
     Agent SSE

    - /
    - 
    -  reasoningcontenttool_starttool_resultdone 
    """
    agent_manager = request.app.state.agent_manager

    try:
        agent = agent_manager.get_or_create(
            body.session_id,
            project_id=body.project_id
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Agent : {e}"
        )

    async def event_generator():
        """
        Run blocking agent stream in a worker thread so the FastAPI event loop
        remains responsive for other sessions/projects.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        stop_event = threading.Event()

        def worker():
            try:
                for event in agent.run_stream_locked(body.message, resume=body.resume):
                    if stop_event.is_set():
                        break
                    loop.call_soon_threadsafe(queue.put_nowait, event)
            except Exception as e:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    {"type": "error", "data": str(e)}
                )
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        disconnected = False
        try:
            while True:
                if await request.is_disconnected():
                    stop_event.set()
                    agent.interrupt()
                    disconnected = True
                    break

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue

                if event is None:
                    break

                sse_data = json.dumps(
                    {"type": event["type"], "data": event["data"]},
                    ensure_ascii=False
                )
                yield f"data: {sse_data}\n\n"

            yield "data: [DONE]\n\n"
        finally:
            stop_event.set()
            if disconnected:
                agent.interrupt()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  #  Nginx 
        }
    )
