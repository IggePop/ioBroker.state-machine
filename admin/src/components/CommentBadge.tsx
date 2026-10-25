import React from "react";
import { Tooltip } from "@mui/material";
import type { SxProps } from "@mui/material";
import { ChatBubbleOutline as CommentIcon } from "@mui/icons-material";

/**
 * Shows that an element has a comment, the comment itself is shown as tooltip
 *
 * @param props Component properties
 * @param props.comment The comment, nothing is shown if it is empty
 * @param props.sx Additional styles of the icon
 */
export default function CommentBadge({
    comment,
    sx,
}: {
    comment: string | undefined;
    sx?: SxProps;
}): React.JSX.Element | null {
    if (!comment?.trim()) {
        return null;
    }
    return (
        <Tooltip title={<span style={{ whiteSpace: "pre-wrap" }}>{comment.trim()}</span>}>
            <CommentIcon
                sx={{ fontSize: 14, opacity: 0.7, cursor: "help", ...sx }}
                aria-label={comment}
            />
        </Tooltip>
    );
}
